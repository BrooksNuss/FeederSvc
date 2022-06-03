import {Consumer} from 'sqs-consumer';
import AWS from 'aws-sdk';
import { Agent } from 'https';
import { FeederSqsMessage, UpdateFields } from '../models/FeederSqsMessage';
import * as FeederConfig from './feeders.json';
import { Gpio } from 'pigpio';
import { FeederInfo } from '../models/FeederInfo';

console.log('Starting pi feeder server.');
const credentials = new AWS.SharedIniFileCredentials({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const awslocal = AWS.config;
AWS.config.region = region;
AWS.config.credentials = credentials;
const dynamo = new AWS.DynamoDB.DocumentClient({
	region: region,
	credentials: credentials
});
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
			const feeder: FeederConfig | undefined = FeederConfig.Feeders.find((feeder: any) => feeder.id === body.id);
			let res;
			if (feeder) {
				switch(body.type) {
				case 'activate':
					console.log(`Activating feeder [${feeder.id}] motor`);
					res = await activateMotor(feeder);
					// if (res) {
						updateFeeder(body.id);
					// }
					break;
				case 'update':
					console.log(`Updating feeder [${feeder.id}]`);
					updateFeeder(body.id, body.fields);
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

async function activateMotor(feeder: FeederConfig): Promise<boolean> {
	try {
		const motor = new Gpio(feeder.pin, {mode: Gpio.OUTPUT});
		// rotate 2s, reverse 1s (helps prevent getting stuck), repeat
		motor.servoWrite(2500);
		await wait(feeder.feedTimer);
		motor.servoWrite(500);
		await wait(feeder.feedTimer);
		motor.servoWrite(2500);
		await wait(feeder.feedTimer);
		motor.servoWrite(500);
		await wait(feeder.feedTimer);
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

async function updateFeeder(id: string, updateFields?: UpdateFields[]): Promise<void> {
	console.log('Fetching feeder by id: ' + id);
	// key type in docs is different from what the sdk expects. type should be GetItemInput
	const getParams = {
		TableName: 'feeders',
		Key: {id}
	};
	let queryResult;
	let feeder: FeederInfo;
	try {
		queryResult = await dynamo.get(getParams).promise();
		feeder = queryResult.Item as FeederInfo;
	} catch (e) {
		console.error(`Failed to get feeder with id [${id}] from DynamoDB.`);
		console.error(e);
		return;
	}
	let updateParams;
	if (updateFields) {
		let updateExpression = 'set ';
		const expressionValues = {};
		updateFields.forEach((field, index) => {
			const fieldValueName = '=:' + field.key;
			updateExpression += field.key + fieldValueName + (index === updateFields.length ? '' : ', ');
			(expressionValues as any)[fieldValueName] = field.value;
		});
		updateParams = {
			TableName: 'feeders',
			Key:{ id },
			UpdateExpression: updateExpression,
			ExpressionAttributeValues: expressionValues
		};
	} else {
		updateFeederDetail(feeder);
		updateParams = {
			TableName: 'feeders',
			Key:{ id },
			UpdateExpression: 'set nextActive=:n, lastActive=:l, estRemainingFood=:erfood, estRemainingFeedings=:erfeedings',
			ExpressionAttributeValues:{
				':n': feeder.nextActive,
				':l': feeder.lastActive,
				':erfood': feeder.estRemainingFood,
				':erfeedings': feeder.estRemainingFeedings
			}
		};
	}
	try {
		const res = await dynamo.update(updateParams).promise();
		if (res) {
			console.log('Successfully updated db record for feeder {%s}', id);
		} else {
			console.error('Error when writing db record for feeder {%s}', id);
			console.error(res);
		}
	} catch (e) {
		console.error(`Failed to get feeder with id [${id}] from DynamoDB.`);
		console.error(e);
	}
}

function updateFeederDetail(feeder: FeederInfo): void {
	const now = Date.now();
	const intervalValues = feeder.interval.split(':');
	const newInterval = new Date(0).setHours(parseInt(intervalValues[0]), parseInt(intervalValues[1]));
	feeder.nextActive = now + newInterval;
	feeder.lastActive = now;
	feeder.estRemainingFood = Math.max(feeder.estRemainingFood - feeder.estFoodPerFeeding, 0);
	feeder.estRemainingFeedings = feeder.estRemainingFood / feeder.estFoodPerFeeding;
}

type FeederConfig = {id: string, pin: number, feedTimer: number};