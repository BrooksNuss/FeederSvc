import { Consumer } from 'sqs-consumer-v3';
import { fromIni } from '@aws-sdk/credential-providers';
import { SQS } from '@aws-sdk/client-sqs';
import { DynamoDB, UpdateItemCommandInput, GetItemCommandInput, GetItemCommandOutput, AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayV2 } from '@aws-sdk/client-apigatewayv2';
import { FeederSqsMessage, UpdateFields } from '../models/FeederSqsMessage';
import * as FeederConfig from './feeders.json';
import { Gpio } from 'pigpio';
import { FeederInfo } from '../models/FeederInfo';
import { HomeWebsocketUpdateRequest } from '../models/HomeWebsocketUpdateRequest';
import { DateTime, Duration } from 'luxon';
import axios from 'axios';

console.log('Starting pi feeder server.');
// const credentials = new AWS.SharedIniFileCredentials({profile: 'pi-sqs-consumer'});
const credentials = fromIni({profile: 'pi-sqs-consumer'});
const region = 'us-east-1';
const queueName = 'FeederQueue';
const wsApiName = 'HomeWS';
let wsApiUrl: string;

const dynamo = new DynamoDB({
	region: region,
	credentials: credentials
});
const sqs = new SQS({
	region: region,
	credentials: credentials
});
const apigw = new ApiGatewayV2({
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

const getWSApiUrl = async () => {
	const apiList = (await apigw.getApis({})).Items;
	const wsApi = apiList?.find(api => api.Name?.includes(wsApiName));

	if (!wsApi) {
		console.error('Specified API does not exist');
		return;
	}
	console.log('Websocket API with name [' + wsApiName + '] found');

	return wsApi.ApiEndpoint?.replace('wss', 'https') + '/dev/@connections';
};

(async () => {
	const queueUrl = await getQueueUrl();
	wsApiUrl = await getWSApiUrl() || '';
	if (!wsApiUrl) {
		console.error('Failed to fetch websocket API endpoint.');
	}

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

async function updateFeeder(id: string, updateFields?: UpdateFields, activated?: boolean): Promise<void> {
	console.log('Fetching feeder by id: ' + id);
	// key type in docs is different from what the sdk expects. type should be GetItemInput
	const getParams: GetItemCommandInput = {
		TableName: 'feeders',
		Key: {
			id: { S: id },
		},
	};
	let queryResult: GetItemCommandOutput;
	let feeder: FeederInfo;
	try {
		queryResult = await dynamo.getItem(getParams);
		if (!queryResult.Item) {
			throw('Empty item in queryResult for params: ' + getParams);
		}
		feeder = extractValuesFromDbResult<FeederInfo>(queryResult.Item);
		// feeder = queryResult.Item as unknown as FeederInfo;
	} catch (e) {
		console.error(`Failed to get feeder with id [${id}] from DynamoDB.`);
		console.error(e);
		return;
	}
	// type of UpdateItemInput
	let updateParams: UpdateItemCommandInput;
	if (updateFields) {
		if (updateFields.estRemainingFood) {
			updateFields.estRemainingFeedings = Math.floor(updateFields.estRemainingFood / feeder.estFoodPerFeeding);
		}
		let updateExpression = 'set ';
		const expressionValues = {};
		const expressionNames = {};
		const updateList = Object.entries(updateFields);
		updateList.forEach((pair, index) => {
			const expressionAttrValue = ':' + pair[0];
			const expressionAttrName = '#' + pair[0];
			updateExpression += expressionAttrName + '=' + expressionAttrValue + (index === updateList.length - 1 ? '' : ', ');
			(expressionValues as any)[expressionAttrValue] = pair[1];
			(expressionNames as any)[expressionAttrName] = pair[0];
		});
		updateParams = {
			TableName: 'feeders',
			Key: {
				id: { S: id },
			},
			UpdateExpression: updateExpression,
			ExpressionAttributeValues: expressionValues,
			ExpressionAttributeNames: expressionNames,
			ReturnValues: 'ALL_NEW'
		};
	} else {
		updateFeederDetailAfterActivating(feeder, activated);
		updateParams = {
			TableName: 'feeders',
			Key: {
				id: { S: id },
			},
			UpdateExpression: 'set nextActive=:n' + (activated ? ', lastActive=:l' : '') + ', estRemainingFood=:erfood, estRemainingFeedings=:erfeedings',
			ExpressionAttributeValues:{
				':n': { S: feeder.nextActive.toString() },
				':erfood': { S: feeder.estRemainingFood.toString() },
				':erfeedings': { S: feeder.estRemainingFeedings.toString() }
			},
			ReturnValues: 'ALL_NEW'
		};
		if (activated) {
			(updateParams.ExpressionAttributeValues as any)[':l'] = feeder.lastActive;
		}
	}
	try {
		//TODO: FIX HERE
		const res = await dynamo.updateItem(updateParams);
		if (res) {
			console.log('Successfully updated db record for feeder {%s}', id);
			if (res.Attributes) {
				sendWebsocketUpdate({action: 'sendNotification', type: 'feederUpdate', value: res.Attributes as any});
			}
		} else {
			console.error('Error when writing db record for feeder {%s}', id);
			console.error(res);
		}
	} catch (e) {
		console.error(`Failed to update feeder with id [${id}] in DynamoDB.`);
		console.error(e);
	}
}

function updateFeederDetailAfterActivating(feeder: FeederInfo, activated?: boolean): void {
	const intervalValues = feeder.interval.split(':');
	const now = DateTime.now();
	const newInterval = Duration.fromObject({hours: parseInt(intervalValues[0]), minutes: parseInt(intervalValues[1])});
	feeder.nextActive = now.plus(newInterval).toMillis();
	feeder.lastActive = now.toMillis();
	if (activated) {
		feeder.estRemainingFood = Math.max(feeder.estRemainingFood - feeder.estFoodPerFeeding, 0);
		feeder.estRemainingFeedings = feeder.estRemainingFood / feeder.estFoodPerFeeding;
	}
}

async function sendWebsocketUpdate(update: HomeWebsocketUpdateRequest): Promise<void> {
	if (!wsApiUrl) {
		console.warn('Websocket API url is not defined. Skipping update.');
		return;
	}
	try {
		const res = await axios.post(wsApiUrl, update);
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

type FeederConfig = {id: string, pin: number, feedTimer: number};