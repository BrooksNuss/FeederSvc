import { Consumer } from 'sqs-consumer-v3';
import { fromIni } from '@aws-sdk/credential-providers';
import { SQS } from '@aws-sdk/client-sqs';
import { APIGateway } from '@aws-sdk/client-api-gateway';
import { FeederSqsMessage, FeederUpdateRequest } from '../models/FeederSqsMessage';
import { Gpio } from 'pigpio';
import { aws4Interceptor } from 'aws4-axios';
import axios from 'axios';
import { FeederInfo } from '../models/FeederInfo';

console.log('Starting pi feeder server.');
const credentials = fromIni({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const feederApiName = 'feeder';
let feederApiUrl = process.env.FEEDER_API_URL;

const sqs = new SQS({
	region: region,
	credentials: credentials
});
const apigw = new APIGateway({
	region: region,
	credentials: credentials
})

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

const getFeederSvcUrl = async () => {
	const apiList = (await apigw.getRestApis({})).items;
	const feederApi = apiList?.find(api => api.name?.includes(feederApiName));

	if (!feederApi) {
		console.error('Specified API does not exist');
		return;
	}
	feederApiUrl = 'https://' + feederApi.id + '.execute-api.' + region + '.amazonaws.com';
	console.log('FeederSvc URL found: %s', feederApiUrl);
};

(async () => {
	const queueUrl = await getQueueUrl();
	await getFeederSvcUrl();
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
			const hwInfo: FeederInfo = body.feederInfo;
			let res;
			if (hwInfo) {
				console.log(`Activating feeder [${body.feederInfo.id}] motor`);
				res = await activateMotor(hwInfo);
				// if (res) {
				sendPostActivation({id: body.feederInfo.id, action: 'activate'});
				// }
			} else {
				throw `Could not find feeder with id {${body.feederInfo.id}}`;
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

async function activateMotor(feeder: FeederInfo): Promise<boolean> {
	try {
		const motor = new Gpio(feeder.pin, {mode: Gpio.OUTPUT});
		// rotate 2s, reverse 1s (helps prevent getting stuck), repeat
		motor.servoWrite(2500);
		await wait(feeder.duration);
		motor.servoWrite(500);
		await wait(feeder.duration);
		motor.servoWrite(2500);
		await wait(feeder.duration);
		motor.servoWrite(500);
		await wait(feeder.duration);
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

async function sendPostActivation(req: FeederUpdateRequest): Promise<void> {
	try {
		const res = await axios.post(feederApiUrl + '/dev/post-activation/' + req.id, req);
	} catch (e) {
		console.error('Error sending post-activation request');
		console.error(e);
	}
}

type FeederConfig = {id: string, pin: number, feedTimer: number};