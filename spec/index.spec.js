const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

const Gateway = require('../');
const jwt = require('../jwt');
const Logger = require('smallorange-cloudwatch-logger');
const CacheDriver = require('smallorange-cache-driver');
const beautyError = require('smallorange-beauty-error');
const http = require('http');
const {
	Observable
} = require('rxjs');

chai.use(sinonChai);

const expect = chai.expect;

describe('index.js', () => {
	let gateway;
	let req;
	let res;
	let lambdas;

	beforeEach(() => {
		req = {
			url: 'http://localhost/param1/param2?width=10&height=20',
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

		lambdas = {
			'/': {
				name: 'functionName'
			},
			'/root': {
				name: 'functionName',
				paramsOnly: true,
				base64: true,
				headers: {
					'content-type': 'image/png'
				},
				params: {
					width: 200,
					height: 200
				}
			},
			'/withAuthOnly': {
				name: 'functionName',
				auth: true
			},
			'/withAdminRoleOnly': {
				name: 'functionName',
				auth: {
					roles: ['admin']
				}
			},
			'/withAdminOrPublicRole': {
				name: 'functionName',
				auth: {
					roles: ['admin', 'public']
				}
			}
		};

		sinon.stub(http.Server.prototype, 'listen');

		gateway = new Gateway({
			auth: {
				getSecret: 'mySecret'
			},
			cachePrefix: 'cachePrefix_',
			logGroup: 'spec',
			lambdas,
			redisUrl: 'redis://localhost:6380'
		});
	});

	afterEach(() => {
		http.Server.prototype.listen.restore();
	});

	describe('constructor', () => {
		it('should throw if no logGroup provided', () => {
			expect(() => new Gateway({
				lambdas
			})).to.throw('no logGroup provided.');
		});

		it('should throw if cachePrefix isn\'t a string', () => {
			expect(() => new Gateway({
				lambdas,
				logGroup: 'spec',
				cachePrefix: null
			})).to.throw('cachePrefix must be a string.');
		});

		it('should throw if shouldCache isn\'t a function', () => {
			expect(() => new Gateway({
				lambdas,
				logGroup: 'spec',
				shouldCache: null
			})).to.throw('shouldCache must be a function.');
		});

		it('should throw if getCacheKey isn\'t a function', () => {
			expect(() => new Gateway({
				lambdas,
				logGroup: 'spec',
				getCacheKey: null
			})).to.throw('getCacheKey must be a function.');
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

		it('should have shouldCache', () => {
			expect(gateway.shouldCache).to.be.a('function');
		});

		it('should have cachePrefix', () => {
			expect(gateway.cachePrefix).to.be.a('string');
		});

		it('should have getCacheKey', () => {
			expect(gateway.getCacheKey).to.be.a('function');
		});

		it('should have auth', () => {
			expect(gateway.auth).to.be.an('object');
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
						width: 10
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
					width: 10
				}, 'version')
				.subscribe(null, null, () => {
					expect(gateway.lambda.invoke).to.have.been.calledWithExactly({
						FunctionName: 'name',
						Payload: JSON.stringify({
							width: 10
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
						width: 10
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

			expect(gateway.logger.log).to.have.been.calledWithExactly(err);
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

			expect(res.write).to.have.been.calledWithExactly(JSON.stringify(beautyError(err)));
			expect(res.end).to.have.been.called;
		});
	});

	describe('write', () => {
		it('should statusCode be 200 by default', () => {
			gateway.write(res);

			expect(res.statusCode).to.equal(200);
		});

		it('should statusCode be 202', () => {
			gateway.write(res, '', 202);

			expect(res.statusCode).to.equal(202);
		});

		it('should call res.write with empty string by default', () => {
			gateway.write(res);

			expect(res.write).to.have.been.calledWithExactly('');
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with string', () => {
			gateway.write(res, 'a');

			expect(res.write).to.have.been.calledWithExactly('a');
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with stringified object', () => {
			gateway.write(res, {
				width: 10
			});

			expect(res.write).to.have.been.calledWithExactly(JSON.stringify({
				width: 10
			}));
			expect(res.end).to.have.been.called;
		});

		it('should call res.write with buffer', () => {
			const buffer = new Buffer('');

			gateway.write(res, buffer);

			expect(res.write).to.have.been.calledWithExactly(buffer);
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

	describe('makeError', () => {
		it('should return 500 error', () => {
			const err = gateway.makeError();

			expect(err.statusCode).to.equal(500);
			expect(err.message).to.equal('Unknown Error');
		});

		it('should return 404 error', () => {
			const err = gateway.makeError(404, 'Not Found');

			expect(err.statusCode).to.equal(404);
			expect(err.message).to.equal('Not Found');
		});
	});

	describe('parseUri', () => {
		it('should return single slash', () => {
			expect(gateway.parseUri([])).to.equal('/');
		});

		it('should remove extra slashes', () => {
			expect(gateway.parseUri('///param1/////param2///')).to.equal('/param1/param2');
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
						width: 10,
						height: 20
					},
					root: '/param1',
					url: {
						path: '/param1/param2?width=10&height=20',
						pathname: '/param1/param2',
						query: 'width=10&height=20'
					},
					uri: '/param1/param2'
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
						width: 10,
						height: 20
					},
					root: '/param1',
					url: {
						path: '/param1/param2?width=10&height=20',
						pathname: '/param1/param2',
						query: 'width=10&height=20'
					},
					uri: '/param1/param2'
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
						width: 10,
						height: 20
					},
					root: '/param1',
					url: {
						path: '/param1/param2?width=10&height=20',
						pathname: '/param1/param2',
						query: 'width=10&height=20'
					},
					uri: '/param1/param2'
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
					width: 10
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
							key: `cachePrefix_${args.url.pathname}`
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64: false,
							body: 'result',
							headers: {},
							statusCode: 200
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
							key: `cachePrefix_${args.url.pathname}`
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64: false,
							body: 'result',
							headers: {
								fromResultHeader: 'fromResultHeader'
							},
							statusCode: 200
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

				gateway.callLambda(lambdas['/root'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: `cachePrefix_${args.url.pathname}`
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64: true,
							body: 'result',
							headers: {
								'content-type': 'image/png'
							},
							statusCode: 200
						});
					}, null, done);
			});

			it('should return cached complete result', done => {
				sinon.stub(gateway.cacheDriver, 'get')
					.returns(Observable.of(completeResult));

				gateway.callLambda(lambdas['/root'], args)
					.subscribe(response => {
						expect(gateway.cacheDriver.get).to.have.been.calledWithExactly({
							namespace: args.host,
							key: `cachePrefix_${args.url.pathname}`
						}, sinon.match.func);

						expect(response).to.deep.equal({
							base64: true,
							body: 'result',
							headers: {
								'content-type': 'image/png',
								fromResultHeader: 'fromResultHeader'
							},
							statusCode: 200
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

			it('should not call cache.get if shouldCache is falsy', done => {
				gateway.shouldCache = () => false;

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.cacheDriver.get).not.to.have.been.called;
					}, null, done);
			});

			it('should not call cache.get if getCacheKey doesn\'t returns a string', done => {
				gateway.getCacheKey = () => true;

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

			it('should call invoke with args', done => {
				gateway.shouldCache = () => false;

				gateway.callLambda(lambdas['/'], args)
					.subscribe(() => {
						expect(gateway.invoke).to.have.been.calledWithExactly('functionName', {
							method: args.method,
							headers: args.headers,
							body: args.body,
							params: args.params,
							uri: args.uri
						}, '$LATEST');
					}, null, done);
			});

			it('should call invoke with args.params', done => {
				gateway.shouldCache = () => false;

				gateway.callLambda(lambdas['/root'], args)
					.subscribe(() => {
						expect(gateway.invoke).to.have.been.calledWithExactly('functionName', Object.assign({}, lambdas['/root'].params, args.params), '$LATEST');
					}, null, done);
			});

			it('should return', done => {
				gateway.shouldCache = () => false;

				gateway.callLambda(lambdas['/root'], args)
					.subscribe(response => {
						expect(response).to.deep.equal({
							body: {},
							headers: {
								'content-type': 'image/png'
							},
							base64: true,
							statusCode: 200
						});
					}, null, done);
			});
		});
	});

	describe('handle', () => {
		beforeEach(() => {
			sinon.spy(gateway, 'parseRequest');
			sinon.stub(gateway, 'write');
			sinon.stub(gateway, 'responds');
			sinon.stub(gateway.cacheDriver, 'markToRefresh')
				.returns(Observable.of([0]));
			sinon.stub(gateway.cacheDriver, 'unset')
				.returns(Observable.of([1]));
			sinon.stub(gateway, 'callLambda')
				.returns(Observable.of({
					body: 'body',
					headers: {
						'content-type': 'image/png'
					},
					base64: true
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
			gateway.cacheDriver.markToRefresh.restore();
			gateway.cacheDriver.unset.restore();
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

		describe('with auth', () => {
			it('should call responds with error if lambda requires auth and no one is provided', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAuthOnly';

				gateway.auth = null;
				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.statusCode).to.equal(403);
				expect(err.message).to.equal('Forbidden');
			});

			it('should call responds with error if lambda requires auth.roles and no one is provided', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAdminRoleOnly';

				gateway.auth = null;
				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.statusCode).to.equal(403);
				expect(err.message).to.equal('Forbidden');
			});

			it('should call responds with error if lambda requires auth.roles and role doesn\'t matches', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAdminRoleOnly';

				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.statusCode).to.equal(403);
				expect(err.message).to.equal('Forbidden');
			});

			it('should not call callLambda if lambda requires auth and no one is provided', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAuthOnly';

				gateway.auth = null;
				gateway.handle(req, res);

				expect(gateway.callLambda).not.to.have.been.called;
			});

			it('should not call callLambda if lambda requires auth and role doesn\'t matches', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAdminRoleOnly';

				gateway.handle(req, res);

				expect(gateway.callLambda).not.to.have.been.called;
			});

			it('should call callLambda if requires auth.roles and role matches', () => {
				req.method = 'POST';
				req.url = 'http://localhost/withAdminOrPublicRole';

				gateway.handle(req, res);

				expect(gateway.callLambda).to.have.been.called;
			});
		});

		describe('cache operations', () => {
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
						operation: 'unset',
						keys: ['/']
					});

				req.method = 'POST';
				req.url = 'http://localhost/cache';

				gateway.handle(req, res);

				expect(gateway.cacheDriver.unset).to.have.been.calledWithExactly({
					operation: 'unset',
					namespace: 'http://localhost',
					keys: ['/']
				});
			});
		});

		it('should call callLambda', () => {
			req.url = 'http://localhost?width=10';

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
					width: 10,
					auth: {
						role: 'public'
					}
				},
				root: '/',
				url: {
					path: '/?width=10',
					pathname: '/',
					query: 'width=10'
				},
				uri: '/'
			});
		});

		describe('without auth', () => {
			it('should call callLambda with wildcard', () => {
				lambdas['*'] = {
					name: 'functionName'
				};

				req.url = 'http://localhost/param1/param2/param3?width=10';

				gateway.handle(req, res);

				expect(gateway.callLambda).to.have.been.calledWithExactly(lambdas['*'], {
					body: {},
					hasExtension: false,
					headers: {
						host: 'http://localhost'
					},
					host: 'http://localhost',
					method: 'GET',
					params: {
						width: 10,
						auth: {
							role: 'public'
						}
					},
					root: '/param1',
					url: {
						path: '/param1/param2/param3?width=10',
						pathname: '/param1/param2/param3',
						query: 'width=10'
					},
					uri: '/param1/param2/param3'
				});
			});

			it('should call responds', () => {
				req.url = 'http://localhost?width=10';

				gateway.handle(req, res);

				expect(gateway.responds).to.have.been.calledWithExactly(res, null, 'body', {
					'content-type': 'image/png'
				}, true);
			});

			it('should call responds with plain response', () => {
				gateway.callLambda.restore();
				sinon.stub(gateway, 'callLambda')
					.returns(Observable.of('body'));

				req.url = 'http://localhost?width=10';

				gateway.handle(req, res);

				expect(gateway.responds).to.have.been.calledWithExactly(res, null, 'body', {}, false);
			});

			it('should call responds with error if lambda doesn\'t matches and not cache operation', () => {
				req.url = 'http://localhost/inexistent';

				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.statusCode).to.equal(404);
				expect(err.message).to.equal('Not Found');
			});

			it('should call responds with error if lambda returns statusCode >= 400', () => {
				gateway.callLambda.restore();
				sinon.stub(gateway, 'callLambda')
					.returns(Observable.of({
						body: 'Forbidden Error',
						statusCode: 401
					}));

				req.url = 'http://localhost?width=10';

				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.statusCode).to.equal(401);
				expect(err.message).to.equal('Forbidden Error');
			});
		});

		describe('internal error', () => {
			it('should call responds with error', () => {
				gateway.callLambda.restore();
				sinon.stub(gateway, 'callLambda')
					.returns(Observable.throw(new Error('Internal Error')));

				req.url = 'http://localhost?width=10';

				gateway.handle(req, res);

				const err = gateway.responds.firstCall.args[1];

				expect(err.message).to.equal('Internal Error');
			});
		});
	});

	describe('handleAuth', () => {
		let token;
		let payload;

		beforeEach(done => {
			gateway.auth.allowedFields = [
				'namespace',
				'user'
			];

			gateway.auth.getSecret = sinon.stub()
				.returns('mySecret');

			payload = {
				mightBeHidden: true,
				namespace: 'spec',
				role: 'user',
				user: 'user-0'
			};

			jwt.sign(payload, 'mySecret')
				.subscribe(_token => token = _token, null, done);
		});

		it('should not resolve authorization if no auth', done => {
			gateway.auth = null;

			gateway.handleAuth()
				.subscribe(response => {
					expect(response).to.deep.equal({});
				}, null, done);
		});

		it('should resolve authorization by header', done => {
			gateway.handleAuth({
					params: {
						param1: 'param1',
						param2: 'param2'
					},
					headers: {
						authorization: token,
						header1: 'header1',
						header2: 'header2'
					}
				})
				.subscribe(response => {
					expect(response).to.deep.equal({
						params: {
							param1: 'param1',
							param2: 'param2',
							auth: {
								namespace: 'spec',
								role: 'user',
								user: 'user-0'
							}
						},
						headers: {
							authorization: token,
							header1: 'header1',
							header2: 'header2'
						}
					});
				}, null, done);
		});

		it('should resolve authorization by token', done => {
			gateway.handleAuth({
					params: {
						param1: 'param1',
						param2: 'param2',
						token
					},
					headers: {
						header1: 'header1',
						header2: 'header2'
					}
				})
				.subscribe(response => {
					expect(response).to.deep.equal({
						params: {
							param1: 'param1',
							param2: 'param2',
							auth: {
								namespace: 'spec',
								role: 'user',
								user: 'user-0'
							},
							token
						},
						headers: {
							header1: 'header1',
							header2: 'header2'
						}
					});
				}, null, done);
		});

		it('should resolve without any authorization', done => {
			gateway.handleAuth({
					params: {
						param1: 'param1',
						param2: 'param2'
					},
					headers: {
						header1: 'header1',
						header2: 'header2'
					}
				})
				.subscribe(response => {
					expect(response).to.deep.equal({
						params: {
							param1: 'param1',
							param2: 'param2',
							auth: {
								role: 'public'
							}
						},
						headers: {
							header1: 'header1',
							header2: 'header2'
						}
					});
				}, null, done);
		});

		it('should resolve with empty params and headers', done => {
			gateway.handleAuth()
				.subscribe(response => {
					expect(response).to.deep.equal({
						params: {
							auth: {
								role: 'public'
							}
						}
					});
				}, null, done);
		});

		it('should throw if signature is invalid', done => {
			gateway.handleAuth({
					params: {
						token: token + 1
					}
				})
				.subscribe(null, err => {
					expect(err.message).to.equal('invalid signature');
					done();
				});
		});
	});
});
