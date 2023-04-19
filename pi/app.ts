import { Consumer } from 'sqs-consumer-v3';
import { fromIni } from '@aws-sdk/credential-providers';
import { SQS } from '@aws-sdk/client-sqs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, GetCommandInput, GetCommandOutput, ScanCommandInput, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { APIGateway } from '@aws-sdk/client-api-gateway';
import { FeederSqsMessage, UpdateFields } from '../models/FeederSqsMessage';
import * as FeederConfig from './feeders.json';
import { Gpio } from 'pigpio';
import { FeederInfo } from '../models/FeederInfo';
import { DateTime, Duration } from 'luxon';
import { aws4Interceptor } from 'aws4-axios';
import axios from 'axios';

console.log('Starting pi feeder server.');
const credentials = fromIni({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const wsApiName = 'HomeWSListener';
let websocketUrl: string;

const dynamoClient = DynamoDBDocument.from(new DynamoDB({
	region: region,
	credentials: credentials
}));
const sqs = new SQS({
	region: region,
	credentials: credentials
});
const apigw = new APIGateway({
	region: region,
	credentials: credentials
});

const getQueueUrl = async () => {
	const queueList = (await sqs.listQueues({})).QueueUrls;
	const queueUrl = queueList?.find(queue => queue.includes(queueName));
	
	if (!queueUrl) {
		console.error('Specified queue does not exist');
		return;
	}

	console.log('SQS queue URL found: ' + queueUrl);
	return queueUrl;
};

const getwebsocketUrl = async () => {
	const apiList = (await apigw.getRestApis({})).items;
	const websocketApi = apiList?.find(api => api.name?.includes(wsApiName));

	if (!websocketApi) {
		console.error('Specified API does not exist');
		return;
	}
	console.log('API with name [' + wsApiName + '] found');

	return 'https://' + websocketApi.id + '.execute-api.' + region + '.amazonaws.com' + '/dev/sendnotification';
};

(async () => {
	const queueUrl = await getQueueUrl();
	websocketUrl = await getwebsocketUrl() || '';
	if (!websocketUrl) {
		console.error('Failed to fetch websocket API endpoint.');
	}
	const interceptor = aws4Interceptor(
		{
			region: region,
			service: 'execute-api',
		},
		await credentials()
	);
	axios.interceptors.request.use(interceptor);

	const sqsConsumer = Consumer.create({
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
						updateFeeder(body.id, undefined, true);
						// }
						break;
					case 'update':
						console.log(`Updating feeder [${feeder.id}]`);
						updateFeeder(body.id, body.fields);
						break;
					case 'skip':
						console.log(`Resetting timer of feeder [${feeder.id}]`);
						updateFeeder(body.id);
						break;
				}
			} else {
				throw `Could not find feeder with id {${body.id}}`;
			}
		},
		sqs
	});

	sqsConsumer.on('error', (err) => {
		console.error(err.message);
	});

	sqsConsumer.on('processing_error', (err) => {
		console.error(err.message);
	});

	sqsConsumer.start();
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

async function sendWebsocketUpdate(update: HomeWSSendNotificationRequest): Promise<void> {
	if (!websocketUrl) {
		console.warn('websocket url is not defined. Skipping update.');
		return;
	}
	try {
		const res = await axios.post(websocketUrl, update);
		console.log(res);
	} catch (e) {
		console.error('Error sending push notification for feeder update.', e);
	}
}

function extractValuesFromDbResult<T>(res: Record<string, AttributeValue>): T {
	const result: any = {};
	Object.keys(res).forEach(key => {
		const attributeValue = res[key];
		if (attributeValue.N) {
			result[key] = parseInt(attributeValue.N);
		} else if (attributeValue.S) {
			result[key] = attributeValue.S;
		}
	});
	return result as T;
}

function createAttributeValue(value: string | number): AttributeValue {
	return typeof value === 'string' ? { S: value } : { N: value.toString() };
}

type FeederConfig = {id: string, pin: number, feedTimer: number};