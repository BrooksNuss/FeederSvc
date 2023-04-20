import { APIGatewayProxyHandler } from 'aws-lambda';
import { fromIni } from '@aws-sdk/credential-providers';
import { SQS, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, GetCommandInput, ScanCommandInput, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { FeederApiResources, FeederSqsMessage, FeederUpdateRequest } from '../models/FeederSqsMessage';
import { HomeWSListenerSendNotificationRequest } from '../models/HomeWebsocketUpdateRequest';
import { FeederInfo } from '../models/FeederInfo';
import { DateTime } from 'luxon';
import axios from 'axios';
import { aws4Interceptor } from 'aws4-axios';

const sqs = new SQS({});
const dynamoClient = DynamoDBDocument.from(new DynamoDB({}));
const feederQueueUrl = process.env.FEEDER_QUEUE_URL;
const WSApiUrl = process.env.WS_LISTENER_URL;
const region = 'us-east-1';
const credentials = fromIni({profile: 'pi-sqs-consumer'});

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
		const requestBody = event.body ? JSON.parse(event.body) : null;
		const feeder = id ? await getFeeder(id) : null;

		if (!feeder) {
			throw `Could not find feeder with id [${id}]`;
		}

		switch (event.resource as FeederApiResources) {
			case '/activate/{id}':
				console.log('Received activate message for feeder {%s}', id);
				if (feeder.status === 'OFFLINE') {
					throw `Feeder [${id}] is offline`;
				} else {
					await postSqsMessage({id, type: 'activate'});
					body = 'Success';
				}
				break;
			case '/list-info':
				console.log('Received get list message');
				body = await getFeederList();
				break;
			case '/skip/{id}':
				console.log('Received skip message for feeder {%s}', id);
				if (feeder.status === 'OFFLINE') {
					throw `Feeder [${id}] is offline`;
				} else {
					await postSqsMessage({id, type: 'skip'});
					body = 'Success';
				}
				break;
			case '/toggle-enabled/{id}':
				console.log('Received toggle message for feeder {%s}', id);
				await postSqsMessage({id, type: 'toggle-enabled'});
				body = 'Success';
				break;
			case '/update/{id}':
				console.log('Received update message for feeder {%s}', id);
				if (!requestBody) {
					console.error('Received update request with missing body');
					throw 'Received update request with missing body';
				}
				validateInterval(requestBody);
				handleUpdate(requestBody);
				body = 'Success';
				break;
			case '/postaction/{id}':
			// stuff goes here for handling db updates/websocket updates. called directly from the feeder.
				if (!requestBody) {
					console.error('Received postaction request with missing body');
					throw 'Received update request with missing body';
				}
				handleUpdate(requestBody);
				break;
		}
	} catch (err: any) {
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

async function postSqsMessage(body: FeederSqsMessage) {
	console.log('Posting message to SQS');
	const params: SendMessageCommandInput = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	return sqs.sendMessage(params);
}

async function handleUpdate(request: FeederUpdateRequest): Promise<void> {
	console.log('Fetching feeder by id: ' + request.id);
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
		case 'skip':
			updateFeederDetailAfterActivating(feeder, true);
			updateParams = buildActivateCommand(feeder, true);
			break;
	}
	
	try {
		const res = await dynamoClient.update(updateParams);
		if (res) {
			console.log('Successfully updated db record for feeder {%s}', feeder.id);
			if (res.Attributes) {
				sendWebsocketUpdate({action: 'sendNotification', subscriptionType: 'feederUpdate', value: res.Attributes as FeederInfo});
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

function buildActivateCommand(feeder: FeederInfo, skip = false): UpdateCommandInput {
	const updateParams = {
		TableName: 'feeders',
		Key: {
			id: feeder.id,
		},
		UpdateExpression: 'set ' + (!skip ? 'lastActive=:l, ' : '') + 'estRemainingFood=:erfood, estRemainingFeedings=:erfeedings',
		ExpressionAttributeValues:{
			':erfood': feeder.estRemainingFood.toString(),
			':erfeedings': feeder.estRemainingFeedings.toString()
		},
		ReturnValues: 'ALL_NEW'
	};
	if (!skip) {
		(updateParams.ExpressionAttributeValues as any)[':l'] = feeder.lastActive.toString();
	}
	return updateParams;
}

function updateFeederDetailAfterActivating(feeder: FeederInfo, skip = false): void {
	const now = DateTime.now();
	feeder.lastActive = now.toMillis();
	if (!skip) {
		feeder.estRemainingFood = Math.max(feeder.estRemainingFood - feeder.estFoodPerFeeding, 0);
		feeder.estRemainingFeedings = feeder.estRemainingFood / feeder.estFoodPerFeeding;
	}
}

function validateInterval(request: FeederUpdateRequest): void {
	const matches = request.fields?.interval?.match(/^(?:(?:[1-5]?[0-9],)*(?:[1-5]?[0-9])|\*)\s(?:(?:1?[0-9],|2[0-3],)*(?:1?[0-9]|2[0-3]))\s\*\s\*\s\?\s\*$/);
	if (!matches) {
		throw 'Invalid interval';
	}
}