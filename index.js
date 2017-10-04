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

const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis({
	connection: {
		url: redisUrl
	}
}) : null;

const logGroup = process.env.LOG_GROUP || 'unnamedApp';
const logGroupDebounce = process.env.LOG_GROUP_DEBOUNCE || 5000;
const logger = new Logger({
	client: cloudWatchLogs,
	logGroupName: logGroup,
	debounceTime: Number(logGroupDebounce)
});

const cacheDriver = redisUrl ? new CacheDriver({
	logError: logger.log.bind(logger),
	ttl: null,
	redis
}) : null;

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

const invoke = (name, payload = {}, version = '$LATEST') => {
	return Observable.create(subscriber => {
		lambda.invoke({
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
};

const parseValue = value => {
	if (value === 'true') {
		return true;
	} else if (value === 'false') {
		return false;
	} else if (value === 'null' || value === 'undefined') {
		return null;
	}

	const numberTentative = parseFloat(value);

	if (!isNaN(numberTentative)) {
		return numberTentative;
	}

	return decodeURIComponent(value);
};

const qs = value => value ? value.split('&')
	.reduce((reduction, token) => {
		const [key, value] = token.split('=');

		if (key && value) {
			reduction[key] = parseValue(value);
		}

		return reduction;
	}, {}) : {};

const writeError = (res, err, end = true) => {
	logger.log(err);
	
	res.statusCode = err.status || err.statusCode || 500;
	res.write(JSON.stringify(beautyError(err)));
	end && res.end();
};

const write = (res, data = '', end = true) => {
	res.statusCode = 200;

	if (typeof data === 'object' || typeof data === 'number') {
		res.write(Buffer.isBuffer(data) ? data : JSON.stringify(data));
	} else {
		res.write(data);
	}

	end && res.end();
};

const setHeaders = (res, headers = {}) => {
	headers = Object.assign({
		'content-type': 'application/json',
		'access-control-allow-origin': '*'
	}, headers);

	Object.keys(headers)
		.forEach(key => {
			const value = headers[key];

			res.setHeader(key, value);
		});
};

const responds = (res, err, body, headers = {}, base64Encoded = false) => {
	setHeaders(res, headers);

	if (err) {
		return writeError(res, err);
	}

	if (body && (base64Encoded)) {
		body = new Buffer(body, 'base64');
	}

	write(res, body);
};

const responds404 = res => {
	const err = new Error('Not Found');
	err.statusCode = 404;

	responds(res, err);
};

const parseRequest = (req, callback) => {
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
		params: qs(url.query),
		root: root ? `/${root}` : '/',
		url,
		uri: `/${uri.join('/')}`
			.replace(/\/*$/g, '')
			.replace(/\/{2,}/g, '/') || '/'
	};

	if (req.method === 'POST' || req.method === 'PUT') {
		return bodyParser(req, null, (err, body) => {
			if (err) {
				return callback(err);
			}

			callback(null, Object.assign(args, {
				body
			}));
		});
	}

	callback(null, args);
};

const callLambda = (lambda, args) => {
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

	const cacheEligible = cacheDriver && method === 'GET' && !hasExtension && !url.query;
	const doInvoke = () => invoke(lambda.name, lambda.paramsOnly ? params : {
		method,
		headers,
		body,
		params,
		uri
	}, lambda.version);

	const doCache = () => cacheDriver.get({
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
};

const handle = (req, res) => {
	// responds options
	if (req.method === 'OPTIONS' || req.url === '/favicon.ico') {
		return write(res);
	}

	parseRequest(req, (err, args) => {
		let operation;

		if (err) {
			return responds(res, err);
		}

		const {
			body,
			host,
			method,
			root,
			url
		} = args;

		const lambda = lambdas[root];

		// cache operation
		if (method === 'POST' && url.pathname === '/cache') {
			const {
				operation: cacheOperation = 'markToRefresh'
			} = body;

			if (cacheDriver[cacheOperation]) {
				operation = cacheDriver[cacheOperation](Object.assign({
						namespace: host
					}, body))
					.map(response => ({
						[cacheOperation]: response
					}));
			}
		}

		// do lambda
		if (lambda) {
			operation = callLambda(lambda, args);
		}

		if (operation) {
			return operation
				.subscribe(
					response => {
						if (response.body && response.headers) {
							return responds(res, null, response.body, response.headers, response.base64Encoded || false);
						}

						responds(res, null, response);
					},
					err => responds(res, err)
				);
		}

		responds404(res);
	});
};

http.createServer((req, res) => {
		try {
			handle(req, res);
		} catch (err) {
			logger.log(err);

			writeError(res, err);
		}
	})
	.listen(process.env.PORT || 8080);
