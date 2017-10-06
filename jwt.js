const jwt = require('jsonwebtoken');
const {
	Observable
} = require('rxjs');

/*
	json: force JSON.parse on the payload even if the header doesn't contain "typ":"JWT".
	complete: return an object with the decoded payload and header.
 */
const decode = (token, options = {}) => jwt.decode(token, options);

/*
	algorithm (default: HS256)
	expiresIn: expressed in seconds or a string describing a time span zeit/ms. Eg: 60, "2 days", "10h", "7d"
	notBefore: expressed in seconds or a string describing a time span zeit/ms. Eg: 60, "2 days", "10h", "7d"
	audience
	issuer
	jwtid
	subject
	noTimestamp
	header
 */
const sign = (payload, secret = '', options = {}) => {
	return Observable.create(subscriber => {
		jwt.sign(payload, secret, options, (err, token) => {
			if (err) {
				return subscriber.error(err);
			}

			subscriber.next(token);
			subscriber.complete();
		});
	});
};

/*
	algorithms: List of strings with the names of the allowed algorithms. For instance, ["HS256", "HS384"].
	audience: if you want to check audience (aud), provide a value here
	issuer (optional): string or array of strings of valid values for the iss field.
	ignoreExpiration: if true do not validate the expiration of the token.
	ignoreNotBefore...
	subject: if you want to check subject (sub), provide a value here
	clockTolerance: number of seconds to tolerate when checking the nbf and exp claims, to deal with small clock differences among different servers
 */
const verify = (token, secret = '', options = {}) => {
	return Observable.create(subscriber => {
		jwt.verify(token, secret, options, (err, token) => {
			if (err) {
				return subscriber.error(err);
			}

			subscriber.next(token);
			subscriber.complete();
		});
	});
};

module.exports = {
	decode,
	sign,
	verify
};
