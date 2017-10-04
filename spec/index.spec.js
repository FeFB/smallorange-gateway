const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

const Gateway = require('../');
const Logger = require('smallorange-cloudwatch-logger');
const CacheDriver = require('smallorange-cache-driver');
const beautyError = require('smallorange-beauty-error');
const http = require('http');
const {
	Observable
} = require('rxjs');

chai.use(sinonChai);

const expect = chai.expect;

const lambdas = {
	'/': {
		name: 'images'
	},
	'/images': {
		name: 'images',
		paramsOnly: true,
		base64Encoded: true,
		headers: {
			'content-type': 'image/png'
		}
	}
};

describe('index.js', () => {
	let gateway;
	let req;
	let res;

	beforeEach(() => {
		req = {
			url: 'http://localhost/param1/param2?a=1&b=2',
			headers: {
				host: 'http://localhost'
			},
			method: 'GET'
		};

		res = {
			setHeader: sinon.stub(),
			write: sinon.stub(),
			end: sinon.stub(),
		};
	});

	describe('constructor', () => {
		beforeEach(() => {
			sinon.spy(http.Server.prototype, 'listen');

			gateway = new Gateway({
				logGroup: 'spec',
				lambdas,
				redisUrl: 'redis://localhost:6380'
			});
		});

		afterEach(() => {
			http.Server.prototype.listen.restore();
		});

		it('should throw if no lambdas provided', () => {
			expect(() => new Gateway()).to.throw('no lambdas provided.');
		});

		it('should throw if no logGroup provided', () => {
			expect(() => new Gateway({
				lambdas
			})).to.throw('no logGroup provided.');
		});

		it('should have logger', () => {
			expect(gateway.logger).to.be.instanceOf(Logger);
		});

		it('should have cacheDriver', () => {
			expect(gateway.cacheDriver).to.be.instanceOf(CacheDriver);
		});

		it('should not have cacheDriver if no redisUrl provided', () => {
			gateway = new Gateway({
				logGroup: 'spec',
				lambdas
			});

			expect(gateway.cacheDriver).to.be.null
		});

		it('should have bodyParser', () => {
			expect(gateway.bodyParser).to.be.a('function');
		});

		it('should have cloudWatchLogs', () => {
			expect(gateway.cloudWatchLogs).to.be.an('object');
		});

		it('should have lambda', () => {
			expect(gateway.lambda).to.be.an('object');
		});

		it('should have lambdas', () => {
			expect(gateway.lambdas).to.deep.equal(lambdas);
		});

		it('should have server', () => {
			expect(gateway.server).to.be.instanceOf(http.Server);
		});

		it('should call server.listen', () => {
			expect(http.Server.prototype.listen).to.have.been.called;
		});
	});

	describe('invoke', () => {
		beforeEach(() => {
			sinon.stub(gateway.lambda, 'invoke')
				.callsArgWith(1, null, {
					Payload: JSON.stringify({
						a: 1
					})
				});
		});

		afterEach(() => {
			gateway.lambda.invoke.restore();
		});

		it('should call lambda.invoke with default args', done => {
			gateway.invoke('name')
				.subscribe(null, null, () => {
					expect(gateway.lambda.invoke).to.have.been.calledWithExactly({
						FunctionName: 'name',
						Payload: JSON.stringify({}),
						Qualifier: '$LATEST'
					}, sinon.match.func);

					done();
				});
		});

		it('should call lambda.invoke with custom args', done => {
			gateway.invoke('name', {
					a: 1
				}, 'version')
				.subscribe(null, null, () => {
					expect(gateway.lambda.invoke).to.have.been.calledWithExactly({
						FunctionName: 'name',
						Payload: JSON.stringify({
							a: 1
						}),
						Qualifier: 'version'
					}, sinon.match.func);

					done();
				});
		});

		it('should return Payload', done => {
			gateway.invoke('name')
				.subscribe(response => {
					expect(response).to.deep.equal({
						a: 1
					});
				}, null, done);
		});

		describe('error', () => {
			beforeEach(() => {
				gateway.lambda.invoke.restore();

				sinon.stub(gateway.lambda, 'invoke')
					.callsArgWith(1, new Error('some error'));
			});

			it('should return Payload', done => {
				gateway.invoke('name')
					.subscribe(null, err => {
						expect(err.message).to.equal('some error');
						done();
					});
			});
		});
	});

	describe('parseValue', () => {
		it('should parse true', () => {
			expect(gateway.parseValue('true')).to.be.true;
			expect(gateway.parseValue(true)).to.be.true;
		});

		it('should parse false', () => {
			expect(gateway.parseValue('false')).to.be.false;
			expect(gateway.parseValue(false)).to.be.false;
		});

		it('should parse nil', () => {
			expect(gateway.parseValue('null')).to.be.null;
			expect(gateway.parseValue(null)).to.be.null;
			expect(gateway.parseValue('undefined')).to.be.null;
			expect(gateway.parseValue(undefined)).to.be.null;
		});

		it('should parse number', () => {
			expect(gateway.parseValue('6')).to.equal(6);
			expect(gateway.parseValue(6)).to.equal(6);
			expect(gateway.parseValue('6.66')).to.equal(6.66);
		});

		it('should parse string', () => {
			expect(gateway.parseValue('string string')).to.equal('string string');
			expect(gateway.parseValue(encodeURIComponent('string string'))).to.equal('string string');
		});
	});

	describe('qs', () => {
		it('should parse empty', () => {
			expect(gateway.qs()).to.deep.equal({});
		});

		it('should parse string', () => {
			expect(gateway.qs('false=false&true=true&null=null&undefined=undefined&number=6.66&string=string')).to.deep.equal({
				false: false,
				true: true,
				null: null,
				undefined: null,
				number: 6.66,
				string: 'string'
			});
		});
	});

	describe('writeError', () => {
		let err;

		beforeEach(() => {
			err = new Error();
			sinon.stub(gateway.logger, 'log');
		});

		afterEach(() => {
			gateway.logger.log.restore();
		});

		it('should call logger.log', () => {
			gateway.writeError(res, err);

			expect(gateway.logger.log).to.have.been.calledWith(err);
		});

		it('should statusCode be 500 by default', () => {
			gateway.writeError(res, err);

			expect(res.statusCode).to.equal(500);
		});

		it('should statusCode be 404', () => {
			err.statusCode = 404;
			gateway.writeError(res, err);

			expect(res.statusCode).to.equal(404);
		});

		it('should call res.write and res.end', () => {
			gateway.writeError(res, err);

			expect(res.write).to.have.been.calledWith(JSON.stringify(beautyError(err)));
			expect(res.end).to.have.been.called;
		});
	});

	describe('write', () => {
		it('should statusCode be 200', () => {
			gateway.write(res);

			expect(res.statusCode).to.equal(200);
		});

		it('should call res.write with empty string by default', () => {
			gateway.write(res);

			expect(res.write).to.have.been.calledWith('');
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with string', () => {
			gateway.write(res, 'a');

			expect(res.write).to.have.been.calledWith('a');
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with stringified object', () => {
			gateway.write(res, {
				a: 1
			});

			expect(res.write).to.have.been.calledWith(JSON.stringify({
				a: 1
			}));
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with buffer', () => {
			const buffer = new Buffer('a');

			gateway.write(res, buffer);

			expect(res.write).to.have.been.calledWith(buffer);
			expect(res.end).to.have.been.called;
		});
	});

	describe('setHeaders', () => {
		it('should call res.setHeader with default headers', () => {
			gateway.setHeaders(res);

			expect(res.setHeader).to.have.been.calledWithExactly('content-type', 'application/json');
			expect(res.setHeader).to.have.been.calledWithExactly('access-control-allow-origin', '*');
		});

		it('should call res.setHeader with custom headers', () => {
			gateway.setHeaders(res, {
				'content-type': 'image/png'
			});

			expect(res.setHeader).to.have.been.calledWithExactly('content-type', 'image/png');
			expect(res.setHeader).to.have.been.calledWithExactly('access-control-allow-origin', '*');
		});
	});

	describe('responds', () => {
		beforeEach(() => {
			sinon.stub(gateway, 'setHeaders');
			sinon.stub(gateway, 'writeError');
			sinon.stub(gateway, 'write');
		});

		afterEach(() => {
			gateway.setHeaders.restore();
			gateway.writeError.restore();
			gateway.write.restore();
		});

		it('should call setHeaders with empty headers', () => {
			gateway.responds(res);

			expect(gateway.setHeaders).to.have.been.calledWithExactly(res, {});
		});

		it('should call setHeaders with custom headers', () => {
			gateway.responds(res, null, null, {
				'content-type': 'image/png'
			});

			expect(gateway.setHeaders).to.have.been.calledWithExactly(res, {
				'content-type': 'image/png'
			});
		});

		it('should call writeError', () => {
			const err = new Error();

			gateway.responds(res, err);

			expect(gateway.writeError).to.have.been.calledWithExactly(res, err);
		});

		it('should call write with base64 string', () => {
			const b64 = 'spec'.toString('base64');

			gateway.responds(res, null, b64);

			expect(gateway.write).to.have.been.calledWithExactly(res, b64);
		});

		it('should call write with buffer from base64 string', () => {
			const b64 = 'spec'.toString('base64');

			gateway.responds(res, null, b64, {}, true);

			expect(Buffer.isBuffer(gateway.write.firstCall.args[1])).to.be.true;
		});
	});

	describe('responds404', () => {
		beforeEach(() => {
			sinon.stub(gateway, 'responds');
		});

		afterEach(() => {
			gateway.responds.restore();
		});

		it('should call responds with 404 error', () => {
			gateway.responds404();

			const err = gateway.responds.firstCall.args[1];

			expect(err.statusCode).to.equal(404);
		});
	});

	describe('parseRequest', () => {
		beforeEach(() => {
			sinon.stub(gateway, 'bodyParser')
				.callsArgWith(2, null, {
					body: 'body'
				});
		});

		afterEach(() => {
			gateway.bodyParser.restore();
		});

		it('should return parsed request with empty body', () => {
			gateway.parseRequest(req, (err, args) => {
				expect(err).to.be.null;
				expect(args).to.deep.equal({
					body: {},
					hasExtension: false,
					headers: {
						host: 'http://localhost'
					},
					host: 'http://localhost',
					method: 'GET',
					params: {
						a: 1,
						b: 2
					},
					root: '/param1',
					url: {
						path: '/param1/param2?a=1&b=2',
						pathname: '/param1/param2',
						query: 'a=1&b=2'
					},
					uri: '/param2'
				});
			});
		});

		it('should return parsed request with body when req.method = POST', () => {
			req.method = 'POST';

			gateway.parseRequest(req, (err, args) => {
				expect(err).to.be.null;
				expect(args).to.deep.equal({
					body: {
						body: 'body'
					},
					hasExtension: false,
					headers: {
						host: 'http://localhost'
					},
					host: 'http://localhost',
					method: 'POST',
					params: {
						a: 1,
						b: 2
					},
					root: '/param1',
					url: {
						path: '/param1/param2?a=1&b=2',
						pathname: '/param1/param2',
						query: 'a=1&b=2'
					},
					uri: '/param2'
				});
			});
		});

		it('should return parsed request with body when req.method = PUT', () => {
			req.method = 'PUT';

			gateway.parseRequest(req, (err, args) => {
				expect(err).to.be.null;
				expect(args).to.deep.equal({
					body: {
						body: 'body'
					},
					hasExtension: false,
					headers: {
						host: 'http://localhost'
					},
					host: 'http://localhost',
					method: 'PUT',
					params: {
						a: 1,
						b: 2
					},
					root: '/param1',
					url: {
						path: '/param1/param2?a=1&b=2',
						pathname: '/param1/param2',
						query: 'a=1&b=2'
					},
					uri: '/param2'
				});
			});
		});
	});

	describe('callLambda', () => {
		let args;

		const plainResult = 'result';
		const completeResult = {
			headers: {
				fromResultHeader: 'fromResultHeader'
			},
			body: 'result'
		};

		beforeEach(() => {
			args = {
				body: {},
				hasExtension: false,
				headers: {},
				host: 'localhost',
				method: 'GET',
				params: {
					a: 1
				},
				uri: '/',
				url: {
					pathname: '/'
				}
			};
		});

		describe('cached', () => {
			afterEach(() => {
				gateway.cacheDriver.get.restore();
			});

			it('should return cached plain result', done => {
				sinon.stub(gateway.cacheDriver, 'get')
					.returns(Observable.of(plainResult));

				gateway.callLambda(lambdas['/'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: args.url.pathname
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64Encoded: false,
							body: 'result',
							headers: {}
						});
					}, null, done);
			});

			it('should return cached complete result', done => {
				sinon.stub(gateway.cacheDriver, 'get')
					.returns(Observable.of(completeResult));

				gateway.callLambda(lambdas['/'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: args.url.pathname
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64Encoded: false,
							body: 'result',
							headers: {
								fromResultHeader: 'fromResultHeader'
							}
						});
					}, null, done);
			});
		});

		describe('cached with mocked headers and base64', () => {
			afterEach(() => {
				gateway.cacheDriver.get.restore();
			});

			it('should return cached plain result', done => {
				sinon.stub(gateway.cacheDriver, 'get')
					.returns(Observable.of(plainResult));

				gateway.callLambda(lambdas['/images'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: args.url.pathname
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64Encoded: true,
							body: 'result',
							headers: {
								'content-type': 'image/png'
							}
						});
					}, null, done);
			});

			it('should return cached complete result', done => {
				sinon.stub(gateway.cacheDriver, 'get')
					.returns(Observable.of(completeResult));

				gateway.callLambda(lambdas['/images'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: args.url.pathname
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64Encoded: true,
							body: 'result',
							headers: {
								'content-type': 'image/png',
								fromResultHeader: 'fromResultHeader'
							}
						});
					}, null, done);
			});
		});

		describe('not cached', () => {
			beforeEach(() => {
				sinon.stub(gateway.cacheDriver, 'get');
				sinon.stub(gateway, 'invoke')
					.returns(Observable.of({}));
			});

			afterEach(() => {
				gateway.cacheDriver.get.restore();
				gateway.invoke.restore();
			});

			it('should not call cache.get if req.method !== GET', done => {
				args.method = 'POST';

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.cacheDriver.get).not.to.have.been.called;
					}, null, done);
			});

			it('should not call cache.get if no cacheDriver', done => {
				const cacheDriver = gateway.cacheDriver;
				gateway.cacheDriver = null;

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(cacheDriver.get).not.to.have.been.called;
						gateway.cacheDriver = cacheDriver;
					}, null, done);
			});

			it('should not call cache.get is hasExtension', done => {
				args.hasExtension = true;

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.cacheDriver.get).not.to.have.been.called;
					}, null, done);
			});

			it('should not call cache.get is url.query', done => {
				args.url.query = 'a=1';

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.cacheDriver.get).not.to.have.been.called;
					}, null, done);
			});

			it('should call invoke with args', done => {
				args.method = 'POST';

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.invoke).to.have.been.calledWith('images', {
							method: args.method,
							headers: args.headers,
							body: args.body,
							params: args.params,
							uri: args.uri
						});
					}, null, done);
			});

			it('should call invoke with args.params', done => {
				args.method = 'POST';

				gateway.callLambda(lambdas['/images'], args)
					.subscribe(() => {
						expect(gateway.invoke).to.have.been.calledWith('images', args.params);
					}, null, done);
			});
		});
	});

	describe('handle', () => {
		beforeEach(() => {
			sinon.spy(gateway, 'parseRequest');
			sinon.stub(gateway, 'write');
			sinon.stub(gateway, 'responds');
			sinon.stub(gateway, 'responds404');
			sinon.stub(gateway.cacheDriver, 'markToRefresh')
				.returns(Observable.of([0]));
			sinon.stub(gateway.cacheDriver, 'clear')
				.returns(Observable.of([1]));
			sinon.stub(gateway, 'callLambda')
				.returns(Observable.of({
					body: 'body',
					headers: {
						'content-type': 'image/png'
					},
					base64Encoded: true
				}));
			sinon.stub(gateway, 'bodyParser')
				.callsArgWith(2, null, {
					keys: ['/']
				});
		});

		afterEach(() => {
			gateway.parseRequest.restore();
			gateway.write.restore();
			gateway.responds.restore();
			gateway.responds404.restore();
			gateway.cacheDriver.markToRefresh.restore();
			gateway.cacheDriver.clear.restore();
			gateway.callLambda.restore();
			gateway.bodyParser.restore();
		});

		it('should call write if req.method === OPTIONS', () => {
			req.method = 'OPTIONS';

			gateway.handle(req, res);

			expect(gateway.write).to.have.been.calledWithExactly(res);
		});

		it('should call write if req.url === /favicon.ico', () => {
			req.url = '/favicon.ico';

			gateway.handle(req, res);

			expect(gateway.write).to.have.been.calledWithExactly(res);
		});

		it('should call parseRequest', () => {
			gateway.handle(req, res);

			expect(gateway.parseRequest).to.have.been.calledWithExactly(req, sinon.match.func);
		});

		it('should call cacheDriver.markToRefresh as default operation', () => {
			req.method = 'POST';
			req.url = 'http://localhost/cache';

			gateway.handle(req, res);

			expect(gateway.cacheDriver.markToRefresh).to.have.been.calledWithExactly({
				namespace: 'http://localhost',
				keys: ['/']
			});
		});

		it('should call cacheDriver with custom operation', () => {
			gateway.bodyParser.restore();
			sinon.stub(gateway, 'bodyParser')
				.callsArgWith(2, null, {
					operation: 'clear',
					keys: ['/']
				});

			req.method = 'POST';
			req.url = 'http://localhost/cache';

			gateway.handle(req, res);

			expect(gateway.cacheDriver.clear).to.have.been.calledWithExactly({
				operation: 'clear',
				namespace: 'http://localhost',
				keys: ['/']
			});
		});

		it('should call callLambda', () => {
			req.url = 'http://localhost?a=1';

			gateway.handle(req, res);

			expect(gateway.callLambda).to.have.been.calledWithExactly(lambdas['/'], {
				body: {},
				hasExtension: false,
				headers: {
					host: 'http://localhost'
				},
				host: 'http://localhost',
				method: 'GET',
				params: {
					a: 1
				},
				root: '/',
				url: {
					path: '/?a=1',
					pathname: '/',
					query: 'a=1'
				},
				uri: '/'
			});
		});

		it('should call responds', () => {
			req.url = 'http://localhost?a=1';

			gateway.handle(req, res);

			expect(gateway.responds).to.have.been.calledWithExactly(res, null, 'body', {
				'content-type': 'image/png'
			}, true);
		});

		it('should call responds with plain response', () => {
			gateway.callLambda.restore();
			sinon.stub(gateway, 'callLambda')
				.returns(Observable.of('body'));

			req.url = 'http://localhost?a=1';

			gateway.handle(req, res);

			expect(gateway.responds).to.have.been.calledWithExactly(res, null, 'body');
		});

		it('should call responds404 if lambda doesn\'t matches', () => {
			req.url = 'http://localhost/inexistent';

			gateway.handle(req, res);

			expect(gateway.responds404).to.have.been.calledWithExactly(res);
		});

		describe('error', () => {
			it('should call responds with error', () => {
				const err = new Error();

				gateway.callLambda.restore();
				sinon.stub(gateway, 'callLambda')
					.returns(Observable.throw(err));

				req.url = 'http://localhost?a=1';

				gateway.handle(req, res);

				expect(gateway.responds).to.have.been.calledWithExactly(res, err);
			});
		});
	});
});
