import { APIGatewayProxyHandler } from 'aws-lambda';
import { fromEnv } from '@aws-sdk/credential-providers';
import { SQS, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, GetCommandInput, ScanCommandInput, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { FeederApiResources, FeederSqsMessage, FeederUpdateRequest, UpdateFields } from '../models/FeederSqsMessage';
import { HomeWSListenerSendNotificationRequest } from '../models/HomeWebsocketUpdateRequest';
import { FeederInfo } from '../models/FeederInfo';
import { DateTime } from 'luxon';
import axios from 'axios';
import { aws4Interceptor } from 'aws4-axios';
import { EventBridgeClient, PutRuleCommand } from '@aws-sdk/client-eventbridge';

const sqs = new SQS({});
const dynamoClient = DynamoDBDocument.from(new DynamoDB({}));
const feederQueueUrl = process.env.FEEDER_QUEUE_URL;
const WSApiUrl = process.env.WS_LISTENER_URL;
const region = 'us-east-1';
const credentials = fromEnv();
export const eventBridgeClient = new EventBridgeClient({ region: region });

export const handler: APIGatewayProxyHandler = async (event, context) => {
	console.log('Received event:', JSON.stringify(event, null, 2));

	const interceptor = aws4Interceptor(
		{
			region: region,
			service: 'execute-api',
		},
		await credentials()
	);
	axios.interceptors.request.use(interceptor);

	let body;
	let statusCode = 200;
	const headers = {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin' : '*'
	};
	
	try {
		const id = event.pathParameters?.id || '';
		const requestBody = event.body ? JSON.parse(event.body) as UpdateFields : null;
		console.log('Request body:');
		console.log(event.body);
		const feeder = id ? await getFeeder(id) : null;

		switch (event.resource as FeederApiResources) {
			case '/activate/{id}':
				console.log('Received activate message for feeder {%s}', id);
				activate(feeder, id);
				body = 'Success';
				break;
			case '/service-activate/{id}':
				console.log('Received service activate message for feeder {%s}', id);
				activate(feeder, id);
				body = 'Success';
				break;
			case '/list-info':
				console.log('Received get list message');
				body = await getFeederList();
				break;
			case '/skip/{id}':
				console.log('Received skip message for feeder {%s}', id);
				if (!feeder) {
					throw `Could not find feeder with id [${id}]`;
				}
				if (!feeder.enabled) {
					throw `Feeder [${id}] is offline`;
				} else {
					feeder.skipNext = !feeder.skipNext;
					await handleUpdate({id: feeder.id, action: 'update', fields: {skipNext: feeder.skipNext}});
					body = 'Success';
				}
				break;
			case '/toggle-enabled/{id}':
				console.log('Received toggle message for feeder {%s}', id);
				if (!feeder) {
					throw `Could not find feeder with id [${id}]`;
				}
				feeder.enabled = !feeder.enabled;
				await handleUpdate({id: feeder.id, action: 'update', fields: {enabled: feeder.enabled}});
				body = 'Success';
				break;
			case '/update/{id}':
			case '/service-update/{id}':
				console.log('Received update message for feeder {%s}', id);
				if (!feeder) {
					throw `Could not find feeder with id [${id}]`;
				}
				if (!requestBody) {
					console.error('Received update request with missing body');
					throw 'Received update request with missing body';
				}
				validateInterval(requestBody);
				await handleUpdate({id: feeder.id, fields: requestBody, action: 'update'});
				try {
					if (requestBody?.interval) {
						console.log('Updating EventBridge rule for feeder {%s}', feeder.id);
						const command = new PutRuleCommand({
							Name: feeder.id,
							ScheduleExpression: 'cron(' + requestBody?.interval + ')',
							State: 'ENABLED',
						});
						const res = await eventBridgeClient.send(command);
						console.log('Updated EventBridge rule for feeder {%s}', feeder.id);
						console.log(res);
					}
				} catch (e) {
					console.error('Error updating EventBridge rules for feeder {%s}', feeder.id);
					console.error(e);
				}
				body = 'Success';
				break;
			case '/post-activation/{id}':
			// stuff goes here for handling db updates/websocket updates. called directly from the feeder.
				if (!feeder) {
					throw `Could not find feeder with id [${id}]`;
				}
				if (!requestBody) {
					console.error('Received postactivation request with missing body');
					throw 'Received update request with missing body';
				}
				await handleUpdate({id: feeder.id, fields: requestBody, action: 'activate'});
				break;
		}
	} catch (err: any) {
		console.error('Error when handling incoming request');
		console.error(err);
		statusCode = 400;
		body = err.message;
	} finally {
		body = JSON.stringify(body);
	}

	return {
		statusCode,
		body,
		headers,
	};
};

async function activate(feeder: FeederInfo | null, id: string): Promise<void> {
	try {
		if (!feeder) {
			throw `Could not find feeder with id [${id}]`;
		}
		if (!feeder.enabled) {
			throw `Feeder [${id}] is offline`;
		} else if (feeder.estRemainingFood <= 0) {
			throw `Feeder [${id}] is out of food`;
		} else if (feeder.skipNext) {
			console.log('Feeder {%s} is skipping the current activation', id);
			feeder.skipNext = !feeder.skipNext;
			await handleUpdate({id: feeder.id, action: 'update', fields: {skipNext: feeder.skipNext}});
		} else {
			await postSqsMessage({type: 'activate', feederInfo: feeder});
		}
	} catch (err) {
		console.error('Error during activation');
		console.error(err);
	}
}

async function getFeederList(): Promise<FeederInfo[]> {
	console.log('Fetching feeder list from DynamoDB');
	const params: ScanCommandInput = {
		TableName: 'feeders'
	};
	const queryResult = dynamoClient.scan(params);
	return (await queryResult).Items as FeederInfo[];
}

async function getFeeder(id: string): Promise<FeederInfo> {
	console.log('Fetching feeder by id: ' + id);
	const params: GetCommandInput = {
		TableName: 'feeders',
		Key: { id: id }
	};
	const queryResult = await dynamoClient.get(params);
	return queryResult.Item as FeederInfo;
}

async function postSqsMessage(body: FeederSqsMessage): Promise<void> {
	console.log('Posting message to SQS');
	console.log(body);
	const params: SendMessageCommandInput = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	try {
		const res = await sqs.sendMessage(params);
		console.log('Completed SQS message send');
		console.log(res);
	} catch (err) {
		console.error('error sending sqs message');
		console.error(err);
	}
}

async function handleUpdate(request: FeederUpdateRequest): Promise<void> {
	console.log('Starting update for feeder with id {%s}', request.id);
	console.log(request);
	// key type in docs is different from what the sdk expects. type should be GetItemInput
	const feeder = await getFeeder(request.id);
	// type of UpdateItemInput
	let updateParams: UpdateCommandInput;
	switch(request.action) {
		case 'update':
			if (!request.fields) {
				console.error('Missing fields for update request');
				return;
			}
			updateParams = buildUpdateCommand(request as Required<FeederUpdateRequest>, feeder);
			break;
		case 'activate':
			updateFeederDetailAfterActivating(feeder);
			updateParams = buildActivateCommand(feeder);
			break;
	}
	
	try {
		const res = await dynamoClient.update(updateParams);
		if (res) {
			console.log('Successfully updated db record for feeder {%s}', feeder.id);
			console.log(res);
			if (res.Attributes) {
				await sendWebsocketUpdate({action: 'sendNotification', subscriptionType: 'feederUpdate', value: res.Attributes as FeederInfo});
			}
		} else {
			console.error('Error when writing db record for feeder {%s}', feeder.id);
			console.error(res);
		}
	} catch (e) {
		console.error(`Failed to update feeder with id [${feeder.id}] in DynamoDB.`);
		console.error(e);
	}
}

async function sendWebsocketUpdate(request: HomeWSListenerSendNotificationRequest): Promise<void> {
	if (!WSApiUrl) {
		console.warn('websocket listener url is not defined. Skipping update.');
		return;
	}
	console.log('Sending websocket message');
	console.log(request);
	try {
		const res = await axios.post(WSApiUrl + '/sendnotification', request);
		console.log(res);
	} catch (e) {
		console.error('Error sending push notification for feeder update.', e);
	}
}

function buildUpdateCommand(request: Required<FeederUpdateRequest>, feeder: FeederInfo): UpdateCommandInput {
	if (request.fields.estRemainingFood) {
		request.fields.estRemainingFeedings = Math.floor(request.fields.estRemainingFood / feeder.estFoodPerFeeding);
	}
	let updateExpression = 'set ';
	const expressionValues = {};
	const expressionNames = {};
	const updateList = Object.entries(request.fields);
	updateList.forEach((pair, index) => {
		const expressionAttrValue = ':' + pair[0];
		const expressionAttrName = '#' + pair[0];
		updateExpression += expressionAttrName + '=' + expressionAttrValue + (index === updateList.length - 1 ? '' : ', ');
		(expressionValues as any)[expressionAttrValue] = pair[1];
		(expressionNames as any)[expressionAttrName] = pair[0];
	});
	return {
		TableName: 'feeders',
		Key: {
			id: request.id,
		},
		UpdateExpression: updateExpression,
		ExpressionAttributeValues: expressionValues,
		ExpressionAttributeNames: expressionNames,
		ReturnValues: 'ALL_NEW'
	};
}

function buildActivateCommand(feeder: FeederInfo): UpdateCommandInput {
	const updateParams = {
		TableName: 'feeders',
		Key: {
			id: feeder.id,
		},
		UpdateExpression: 'set lastActive=:l, estRemainingFood=:erfood, estRemainingFeedings=:erfeedings',
		ExpressionAttributeValues:{
			':erfood': feeder.estRemainingFood,
			':erfeedings': feeder.estRemainingFeedings,
			':l': feeder.lastActive
		},
		ReturnValues: 'ALL_NEW'
	};
	return updateParams;
}

function updateFeederDetailAfterActivating(feeder: FeederInfo): void {
	const now = DateTime.now();
	feeder.lastActive = now.toMillis();
	feeder.estRemainingFood = Math.max(feeder.estRemainingFood - feeder.estFoodPerFeeding, 0);
	feeder.estRemainingFeedings = feeder.estRemainingFood / feeder.estFoodPerFeeding;
}

function validateInterval(request: UpdateFields): void {
	if (request.interval) {
		const matches = request.interval.match(/^(?:(?:[1-5]?[0-9],)*(?:[1-5]?[0-9])|\*)\s(?:(?:1?[0-9],|2[0-3],)*(?:1?[0-9]|2[0-3])|\*)\s\*\s\*\s\?\s\*$/);
		if (!matches) {
			throw 'Invalid interval';
		}
	}
}