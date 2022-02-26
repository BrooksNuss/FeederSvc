import {Consumer} from 'sqs-consumer';
import AWS from 'aws-sdk';
import { Agent } from 'https';
import { FeederSqsMessage } from '../models/FeederSqsMessage';
import FeederConfig from './feeders.json';
import { Gpio } from 'pigpio';
import { FeederInfo } from '../models/FeederInfo';

console.log('Starting pi feeder server.');
const credentials = new AWS.SharedIniFileCredentials({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const awslocal = AWS.config;
const dynamo = new AWS.DynamoDB.DocumentClient;
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
		console.error('Specified queue does not exist');
		return;
	}

	console.log('SQS queue URL found: ' + queueUrl);
	return queueUrl;
};

(async () => {
	const queueUrl = await getQueueUrl();

	const app = Consumer.create({
		queueUrl,
		handleMessage: async (message) => {
			//TODO: add some handlers here and there
			console.log(message);
			const body: FeederSqsMessage = message.Body ? JSON.parse(message.Body) : '';
			const feeder = FeederConfig.Feeders.find(feeder => feeder.id === body.id);
			let res;
			if (feeder) {
				switch(body['type']) {
				case 'activate':
					res = await activateMotor(feeder.pin);
					if (res) {
						updateFeeder(body.id);
					}
					break;
				}
			} else {
				throw `Could not find feeder with id {${body.id}}`;
			}
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
	console.log('Server started.');
})();

async function activateMotor(pin: number): Promise<boolean> {
	const motor = new Gpio(pin, {mode: Gpio.OUTPUT});
	// rotate 2s, reverse .5s (helps prevent getting stuck), rotate 2s again
	try {
		motor.servoWrite(2500);
		await wait(2000);
		motor.servoWrite(500);
		await wait(1000);
		motor.servoWrite(2500);
		await wait(2000);
		motor.servoWrite(0);
	} catch (e) {
		console.error(e);
		return false;
	}
	return true;
}

async function wait(duration: number) {
	return new Promise(resolve => setTimeout(resolve, duration));
}

async function updateFeeder(id: string): Promise<void> {
	console.log('Fetching feeder by id: ' + id);
	// key type in docs is different from what the sdk expects. type should be GetItemInput
	const getParams = {
		TableName: 'feeders',
		Key: {id}
	};
	const queryResult = await dynamo.get(getParams).promise();
	const feeder: FeederInfo = queryResult.Item as FeederInfo;
	udpateFeederTimer(feeder);
	const updateParams = {
		TableName: 'feeders',
		Key:{ id },
		UpdateExpression: 'set info.nextActive = :n, info.lastActive=:l',
		ExpressionAttributeValues:{
			':n': feeder.nextActive,
			':l': feeder.lastActive
		}
	};
	const res = await dynamo.update(updateParams).promise();
	if (res) {
		console.log('Successfully updated db record for feeder {%s}', id);
	} else {
		console.error('Error when writing db record for feeder {%s}', id);
		console.error(res);
	}
}

function udpateFeederTimer(feeder: FeederInfo): void {
	const now = Date.now();
	const intervalValues = feeder.interval.split(':');
	const newInterval = new Date(0).setHours(parseInt(intervalValues[0]), parseInt(intervalValues[1]));
	feeder.nextActive = JSON.stringify(now + newInterval);
	feeder.lastActive = JSON.stringify(now);
}