[![CircleCI](https://circleci.com/gh/feliperohdee/smallorange-gateway.svg?style=svg)](https://circleci.com/gh/feliperohdee/smallorange-gateway)

# Small Orange Gateway

Simple HTTP gateway for lambdas

This gateway takes care to create a HTTP server, call lambda functions, cache into Redis according to provided strategy and log into cloudWatch.

## Sample

### Setup
		// used env vars
		process.env.ACCESS_KEY_ID = 'xxxxx'; // (required)
		process.env.SECRET_ACCESS_KEY = 'xxxxx'; // (required)
		process.env.REGION = 'xxxxx'; // (optional)
		process.env.REDIS_URL = 'xxxxx'; // (optional)
		process.env.LOG_GROUP = 'xxxxx'; // (optional)
		process.env.PORT = 8080; // (optional)
		process.env.CACHE_PREFIX = ''; // (optional)
		process.env.CACHE_TTL = 2592000; // time in seconds to live (optional) default: 30 days
		process.env.CACHE_TTR = 7200; // time in seconds to refresh (optional) default: 2 hours
		process.env.CACHE_TIMEOUT = 1000; // time in ms to wait before route to the origin (optional) default: 1 second

		// lambdas manifest
		const lambdas = {
			'/': {
				name: 'functionName' // required,
				shouldCache: args => args.method === 'GET' && !args.hasExtension && !args.url.query || {boolean},
				getCacheKey: args => args.url.pathname
			},
			'/functionName': {
				name: 'functionName', // required
				// pass just params (not all args as described below) to the lambda function
				paramsOnly: true,
				// default params value, it will be merged with params fetched from query, in case of key collision, the latter is going to have precedence
				params: {
					width: 100,
					height: 100
				},
				// default base64 value, lambda response can override this value, if checked, value will be converted to a buffer before returns to the browser
				base64: true,
				// default headers value, lambda response will be merged with this value, in case of key collision, the latter is going to have precedence
				headers: {
					'content-type': 'image/png'
				}
			},
			'/authOnly': {
				name: 'functionName' // required,
				auth: {
					allowedFields: ['role', 'user', 'loggedAt'], // (optional)
					getSecret: (payload, params, headers) => 'mySecret' || 'mySecret', // (required)
					getToken(params, headers) => params.token || headers.authorization // (optional),
					options: {
						/*
						algorithms: List of strings with the names of the allowed algorithms. For instance, ["HS256", "HS384"].
						audience: if you want to check audience (aud), provide a value here
						issuer (optional): string or array of strings of valid values for the iss field.
						ignoreExpiration: if true do not validate the expiration of the token.
						ignoreNotBefore...
						subject: if you want to check subject (sub), provide a value here
						clockTolerance: number of seconds to tolerate when checking the nbf and exp claims, to deal with small clock differences among different servers
						*/
					}
				}
			},
			'/adminOnly': {
				name: 'functionName' // required,
				auth: {
					// ...
					requiredRoles: ['admin']
				}
			},
			'/adminOrPublic': {
				name: 'functionName' // required,
				auth: {
					// ...
					requiredRoles: ['admin', 'public']
				}
			}

			// note: JWT should have role property, like:
			{
				role: string, // (required)
				...anyOtherParams
			}
		};

		const gateway = new Gateway({
			logGroup: 'myAppLogs', // || env.LOG_GROUP
			lambdas,
			redisUrl: 'redis://localhost:6380', // || env.REDIS_URL
			cachePrefix: '', || // env.CACHE_PREFIX
		});

### Usage Details
		// for a request like
		GET http://localhost/functionName/resource?string=value&number=2&boolean=true&nulled=null

		// lambda function will receive args like:
		{
			body: {},
			hasExtension: false, // if url ends with .jpg or .png
			headers: {
				//...request headers
			},
			host: 'http://localhost',
			method: 'GET',
			// fetched from req.query
			params: {
				string: 'value',
				number: 2,
				boolean: true,
				nulled: null,
				auth: {} // if enabled
			},
			root: '/functionName',
			url: {
				path: '/functionName/resource?string=value&number=2&boolean=true&nulled=null',
				pathname: '/functionName/resource',
				query: 'string=value&number=2&boolean=true&nulled=null'
			},
			uri: '/functionName/resource'
		}

		// or just params if explicity declared at lambdas manifest with "paramsOnly = true":
		{
			string: 'value',
			number: 2,
			boolean: true,
			nulled: null
		}

		// lambdas can responds with just string, or an object with following signature
		{	
			//string or stringified object,
			body: string,
			headers: object,
			base64: boolean,
			statusCode: number // is statusCode >= 400, gateway is going to handle as an error following the Http/1.1 rfc (https://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html)
		}

### Cache handling
		// you can manually mark cache to refresh making a request like:
		POST http://yourhost/cache
		{
			operation: 'markToRefresh',
			namespace: 'http://localhost'
		}

		// or unset
		POST http://yourhost/cache
		{
			operation: 'unset',
			namespace: 'http://localhost',
			keys: ['/', '/cart']
		}

