[![CircleCI](https://circleci.com/gh/feliperohdee/smallorange-gateway.svg?style=svg)](https://circleci.com/gh/feliperohdee/smallorange-gateway)

# Small Orange Gateway

Simple HTTP gateway for lambdas

This gateway takes care to create a HTTP server, call lambda functions, cache into Redis according to provided strategy and log into cloudWatch.

## Sample
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
				nulled: null
			},
			root: '/functionName',
			url: {
				path: '/functionName/resource?string=value&number=2&boolean=true&nulled=null',
				pathname: '/functionName/resource',
				query: 'string=value&number=2&boolean=true&nulled=null'
			},
			uri: '/resource'
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
			base64Encoded: boolean,
			statusCode: number // is statusCode >= 400, gateway is going to handle as an error following the Http/1.1 rfc (https://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html)
		}

		// lambdas manifest
		const lambdas = {
			'/': {
				name: 'images' // required
			},
			'/functionName': {
				name: 'images', // required
				// pass just params (not all args as described above) to the lambda function
				paramsOnly: true,
				// default params value, it will be merged with params fetched from query, in case of key collision, the latter is going to have precedence
				params: {
					width: 100,
					height: 100
				},
				// default base64Encoded value, lambda response can override this value, if checked, value will be converted to a buffer before returns to the browser
				base64Encoded: true,
				// default headers value, lambda response will be merged with this value, in case of key collision, the latter is going to have precedence
				headers: {
					'content-type': 'image/png'
				}
			}
		};
		
		// used vars
		process.env.ACCESS_KEY_ID = 'xxxxx'; // (required)
		process.env.SECRET_ACCESS_KEY = 'xxxxx'; // (required)
		process.env.REGION = 'xxxxx'; // (optional)
		process.env.REDIS_URL = 'xxxxx'; // (optional)
		process.env.LOG_GROUP = 'xxxxx'; // (optional)
		process.env.PORT = 8080; // (optional)
		process.env.CACHE_TTL = null; // seconds to live (optional)
		process.env.CACHE_TTR = 7200; // seconds to refresh (optional)
		process.env.CACHE_TIMEOUT = 1000; // max ms to wait before route to the origin (optional)

		const gateway = new Gateway({
			logGroup: 'myAppLogs', // || env.LOG_GROUP
			lambdas,
			redisUrl: 'redis://localhost:6380', // || env.REDIS_URL
			shouldCache: args => args.method === 'GET' && !args.hasExtension && !args.url.query,
			getCacheKey: args => args.url.pathname
		});

		// you can manually mark cache to refresh making a request like:

		POST http://yourhost/cache
		{
			operation: 'markToRefresh',
			namespace: 'http://http://yourhost'
		}

		// or unset
		POST http://yourhost/cache
		{
			operation: 'unset',
			namespace: 'http://http://yourhost',
			keys: ['/', '/cart']
		}

