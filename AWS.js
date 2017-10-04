const AWS = require('aws-sdk');

AWS.config.update({
	accessKeyId: process.env.ACCESS_KEY_ID,
	secretAccessKey: process.env.SECRET_ACCESS_KEY,
	region: 'us-east-1'
});

module.exports = {
	lambda: new AWS.Lambda(),
	cloudWatchLogs: new AWS.CloudWatchLogs()
};
