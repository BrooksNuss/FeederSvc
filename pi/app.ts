import { Consumer } from 'sqs-consumer-v3';
import { fromIni } from '@aws-sdk/credential-providers';
import { SQS } from '@aws-sdk/client-sqs';
import { FeederSqsMessage, FeederUpdateRequest } from '../models/FeederSqsMessage';
import * as FeederConfig from './feeders.json';
import { Gpio } from 'pigpio';
import { aws4Interceptor } from 'aws4-axios';
import axios from 'axios';

console.log('Starting pi feeder server.');
const credentials = fromIni({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const feederApiUrl = process.env.FEEDER_API_URL;

const sqs = new SQS({
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

(async () => {
	const queueUrl = await getQueueUrl();
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
						sendPostAction({id: body.id, action: 'activate'});
						// }
						break;
					// case 'update':
					// 	console.log(`Updating feeder [${feeder.id}]`);
					// 	updateFeeder(body.id, body.fields);
					// 	break;
					case 'skip':
						console.log(`Resetting timer of feeder [${feeder.id}]`);
						sendPostAction({id: body.id, action: 'skip'});
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

async function sendPostAction(req: FeederUpdateRequest): Promise<void> {
	const res = await axios.post(feederApiUrl + '/postaction', req);
	console.log(res);
}

type FeederConfig = {id: string, pin: number, feedTimer: number};