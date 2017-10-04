const http = require('http');
const bodyParser = require('body/json');
const beautyError = require('smallorange-beauty-error');
const Redis = require('smallorange-redis-client');
const Logger = require('smallorange-cloudwatch-logger');
const CacheDriver = require('smallorange-cache-driver');
const {
	parse
} = require('url');
const {
	Observable
} = require('rxjs');

const {
	lambda,
	cloudWatchLogs
} = require('./AWS');

module.exports = class Gateway {
	constructor(config = {}) {
		const {
			lambdas,
			logGroup = process.env.LOG_GROUP,
			logGroupDebounce = process.env.LOG_GROUP_DEBOUNCE || 5000,
			redisUrl = process.env.REDIS_URL,
			port = process.env.PORT || 8080
		} = config;

		if (!lambdas) {
			throw new Error('no lambdas provided.');
		}

		if (!logGroup) {
			throw new Error('no logGroup provided.');
		}
		
		this.logger = new Logger({
			client: cloudWatchLogs,
			logGroupName: logGroup,
			debounceTime: logGroupDebounce
		});

		this.cacheDriver = redisUrl ? new CacheDriver({
			logError: this.logger.log.bind(this.logger),
			ttl: null,
			redis: new Redis({
				connection: {
					url: redisUrl
				}
			})
		}) : null;

		this.bodyParser = bodyParser;
		this.cloudWatchLogs = cloudWatchLogs;
		this.lambda = lambda;
		this.lambdas = lambdas;
		this.server = http.createServer((req, res) => {
			try {
				this.handle(req, res);
			} catch (err) {
				this.logger.log(err);

				this.writeError(res, err);
			}
		});

		this.server.listen(port);
	}

	invoke(name, payload = {}, version = '$LATEST') {
		return Observable.create(subscriber => {
			this.lambda.invoke({
				FunctionName: name,
				Payload: JSON.stringify(payload),
				Qualifier: version
			}, (err, response) => {
				if (err) {
					return subscriber.error(err);
				}

				subscriber.next(JSON.parse(response.Payload));
				subscriber.complete();
			});
		});
	}

	parseValue(value) {
		if (value === 'true' || value === true) {
			return true;
		} else if (value === 'false' || value === false) {
			return false;
		} else if (value === 'null' || value === 'undefined' || value === null || value === undefined) {
			return null;
		}

		const numberTentative = parseFloat(value);

		if (!isNaN(numberTentative)) {
			return numberTentative;
		}

		return decodeURIComponent(value);
	}

	qs(value) {
		if (!value) {
			return {};
		}

		return value.split('&')
			.reduce((reduction, token) => {
				const [key, value] = token.split('=');

				if (key && value) {
					reduction[key] = this.parseValue(value);
				}

				return reduction;
			}, {});
	}

	writeError(res, err) {
		this.logger.log(err);

		res.statusCode = err.statusCode || 500;
		res.write(JSON.stringify(beautyError(err)));
		res.end();
	}

	write(res, data = '') {
		res.statusCode = 200;

		if (typeof data === 'object' || typeof data === 'number') {
			res.write(Buffer.isBuffer(data) ? data : JSON.stringify(data));
		} else {
			res.write(data);
		}

		res.end();
	}

	setHeaders(res, headers = {}) {
		headers = Object.assign({
			'content-type': 'application/json',
			'access-control-allow-origin': '*'
		}, headers);

		Object.keys(headers)
			.forEach(key => {
				const value = headers[key];

				res.setHeader(key, value);
			});
	}

	responds(res, err, data, headers = {}, base64Encoded = false) {
		this.setHeaders(res, headers);

		if (err) {
			return this.writeError(res, err);
		}

		if (data && base64Encoded) {
			data = new Buffer(data, 'base64');
		}

		this.write(res, data);
	}

	responds404(res) {
		const err = new Error('Not Found');
		err.statusCode = 404;

		this.responds(res, err);
	}

	parseRequest(req, callback) {
		const url = parse(req.url);
		const [,
			root,
			...uri
		] = url.pathname.split('/');

		const args = {
			body: {},
			hasExtension: url.pathname.indexOf('.') >= 0,
			headers: req.headers,
			host: req.headers.host,
			method: req.method,
			params: this.qs(url.query),
			root: root ? `/${root}` : '/',
			url: {
				path: url.path,
				pathname: url.pathname,
				query: url.query
			},
			uri: `/${uri.join('/')}`
				.replace(/\/*$/g, '')
				.replace(/\/{2,}/g, '/') || '/'
		};

		if (req.method === 'POST' || req.method === 'PUT') {
			return this.bodyParser(req, null, (err, body) => {
				if (err) {
					return callback(err);
				}

				callback(null, Object.assign(args, {
					body
				}));
			});
		}

		callback(null, args);
	}

	callLambda(lambda, args) {
		const {
			body,
			hasExtension,
			headers,
			host,
			method,
			params,
			uri,
			url,
		} = args;

		const cacheEligible = this.cacheDriver && method === 'GET' && !hasExtension && !url.query;
		const doInvoke = () => this.invoke(lambda.name, lambda.paramsOnly ? params : {
			method,
			headers,
			body,
			params,
			uri
		}, lambda.version);

		const doCache = () => this.cacheDriver.get({
			namespace: host,
			key: url.pathname
		}, doInvoke);

		return (cacheEligible ? doCache() : doInvoke())
			.map(response => {
				const {
					body,
					headers,
					base64Encoded = lambda.base64Encoded || false
				} = response;

				if (body && headers) {
					return {
						body,
						headers: Object.assign({}, lambda.headers, headers),
						base64Encoded
					};
				}

				return {
					body: response,
					headers: lambda.headers || {},
					base64Encoded
				};
			});
	}

	handle(req, res) {
		// responds options
		if (req.method === 'OPTIONS' || req.url === '/favicon.ico') {
			return this.write(res);
		}

		this.parseRequest(req, (err, args) => {
			let operation;

			if (err) {
				return this.responds(res, err);
			}

			const {
				body,
				host,
				method,
				root,
				url
			} = args;

			const lambda = this.lambdas[root];

			// cache operation
			if (method === 'POST' && url.pathname === '/cache') {
				const {
					operation: cacheOperation = 'markToRefresh'
				} = body;

				if (this.cacheDriver[cacheOperation]) {
					operation = this.cacheDriver[cacheOperation](Object.assign({
							namespace: host
						}, body))
						.map(response => ({
							[cacheOperation]: response
						}));
				}
			}

			// do lambda
			if (lambda) {
				operation = this.callLambda(lambda, args);
			}

			if (operation) {
				return operation
					.subscribe(
						response => {
							if (response.body && response.headers) {
								return this.responds(res, null, response.body, response.headers, response.base64Encoded || false);
							}

							this.responds(res, null, response);
						},
						err => this.responds(res, err)
					);
			}

			this.responds404(res);
		});
	}
}
