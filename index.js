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

const DEFAULT_VERSION = '$LATEST';

module.exports = class Gateway {
	constructor(config = {}) {
		const {
			lambdas,
			logGroup = process.env.LOG_GROUP,
			logGroupDebounce = process.env.LOG_GROUP_DEBOUNCE || 5000,
			redisUrl = process.env.REDIS_URL,
			port = process.env.PORT || 8080,
			shouldCache = args => true,
			getCacheKey = args => args.url.pathname
		} = config;

		if (!lambdas) {
			throw new Error('no lambdas provided.');
		}

		if (!logGroup) {
			throw new Error('no logGroup provided.');
		}

		if (typeof shouldCache !== 'function') {
			throw new Error('shouldCache must be a function.');
		}

		if (typeof getCacheKey !== 'function') {
			throw new Error('getCacheKey must be a function.');
		}

		this.logger = new Logger({
			client: cloudWatchLogs,
			logGroupName: logGroup,
			debounceTime: logGroupDebounce
		});

		this.cacheDriver = redisUrl ? new CacheDriver({
			logError: this.logger.log.bind(this.logger),
			ttl: process.env.CACHE_TTL || null,
			ttr: process.env.CACHE_TTR || 7200,
			redis: new Redis({
				connection: {
					url: redisUrl
				}
			})
		}) : null;

		this.shouldCache = shouldCache;
		this.getCacheKey = getCacheKey;
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

	invoke(name, payload = {}, version = DEFAULT_VERSION) {
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

	write(res, data = '', statusCode = 200) {
		res.statusCode = statusCode;

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

	makeError(statusCode = 500, err = null) {
		err = err instanceof Error ? err : new Error(err || 'Unknown Error');
		err.statusCode = statusCode;

		return err;
	}

	parseUri(uri) {
		return `/${uri.join('/')}`
			.replace(/\/*$/g, '')
			.replace(/\/{2,}/g, '/') || '/';
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
			uri: this.parseUri(uri)
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

		const mergedParams = Object.assign({}, lambda.params, params);
		const shouldCache = this.cacheDriver && this.shouldCache(args);
		const doInvoke = () => this.invoke(lambda.name, lambda.paramsOnly ? mergedParams : {
			method,
			headers,
			body,
			params: mergedParams,
			uri
		}, lambda.version || DEFAULT_VERSION);

		const doCache = () => {
			const key = this.getCacheKey(args);

			if(typeof key !== 'string') {
				return doInvoke();
			}

			return this.cacheDriver.get({
				namespace: host,
				key
			}, doInvoke);
		};

		return (shouldCache ? doCache() : doInvoke())
			.map(response => {
				const {
					body,
					headers,
					base64Encoded = lambda.base64Encoded || false,
					statusCode = 200
				} = response;

				if (body && headers) {
					return {
						body,
						headers: Object.assign({}, lambda.headers, headers),
						base64Encoded,
						statusCode
					};
				}

				return {
					body: response,
					headers: lambda.headers || {},
					base64Encoded,
					statusCode
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

				if (this.cacheDriver && (cacheOperation === 'markToRefresh' || cacheOperation === 'unset')) {
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
							const {
								body = null,
								headers = {},
								base64Encoded = false,
								statusCode = 200
							} = response;

							const err = statusCode >= 400 ? this.makeError(statusCode, body || response) : null;

							this.responds(res, err, body || response, headers, base64Encoded);
						},
						err => {
							this.responds(res, err);
						}
					);
			}

			this.responds(res, this.makeError(404, 'Not Found'));
		});
	}
}
