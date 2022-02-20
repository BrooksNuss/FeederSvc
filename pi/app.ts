import {Consumer} from 'sqs-consumer';
import AWS from 'aws-sdk';
import { Agent } from 'https';

const credentials = new AWS.SharedIniFileCredentials({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const awslocal = AWS.config;
AWS.config.region = region;
AWS.config.credentials = credentials;

const sqs = new AWS.SQS({
	httpOptions: {
		agent: new Agent({
			keepAlive: true
		})
	},
	region: region,
});

const getQueueUrl = async () => {
	const queueList = (await sqs.listQueues().promise()).QueueUrls;
	const queueUrl = queueList?.find(queue => queue.includes(queueName));
	
	if (!queueUrl) {
		console.error("Specified queue does not exist");
		return;
	}

	return queueUrl;
}

(async () => {
	const queueUrl = await getQueueUrl();

	const app = Consumer.create({
		queueUrl,
		handleMessage: async (message) => {
			//TODO: add some handlers here and there
			console.log(message);
		},
		sqs
	});

	app.on('error', (err) => {
		console.error(err.message);
	});

	app.on('processing_error', (err) => {
		console.error(err.message);
	});

	app.start();
})();
