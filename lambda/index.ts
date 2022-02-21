import AWS from 'aws-sdk';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { GetItemInput, ScanInput } from 'aws-sdk/clients/dynamodb';
import { SendMessageRequest } from 'aws-sdk/clients/sqs';
import { FeederApiResources, FeederSqsMessage } from '../models/FeederSqsMessage';
import { FeederInfo } from '../models/FeederInfo';
const sqs = new AWS.SQS;
const dynamo = new AWS.DynamoDB.DocumentClient;
const feederQueueUrl = process.env.FEEDER_QUEUE_URL;

export const handler: APIGatewayProxyHandler = async (event, context) => {
	console.log('Received event:', JSON.stringify(event, null, 2));

	let body;
	let statusCode = 200;
	const headers = {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin' : '*'
	};
	
	try {
		const id = event.pathParameters?.id || '';
		const queryResult = await getFeeder(id);
		const feeder: FeederInfo = queryResult.Item as FeederInfo;
		if (!feeder) {
			throw `Could not find feeder with id {${id}}`;
		}

		switch (event.resource as FeederApiResources) {
		case '/activate/{id}':
			console.log('Received activate message for feeder {%s}', id);
			if (feeder.status === 'OFFLINE') {
				throw `Feeder {${id}} is offline`;
			} else {
				body = postSqsMessage({id, type: 'activate'});
			}
			break;
		case '/list-info':
			console.log('Received get list message');
			body = await getFeederList();
			break;
		case '/skip/{id}':
			console.log('Received skip message for feeder {%s}', id);
			if (feeder.status === 'OFFLINE') {
				throw `Feeder {${id}} is offline`;
			} else {
				body = postSqsMessage({id, type: 'skip'});
			}
			break;
		case '/toggle-enabled/{id}':
			console.log('Received toggle message for feeder {%s}', id);
			body = postSqsMessage({id, type: 'toggle-enabled'});
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

async function getFeederList() {
	console.log('Fetching feeder list from DynamoDB');
	const params: ScanInput = {
		TableName: 'feeders'
	};
	return dynamo.scan(params).promise();
}

function getFeeder(id: string) {
	console.log('Fetching feeder by id: ' + id);
	const params: GetItemInput = {
		TableName: 'feeders',
		Key: {id: {S: id}}
	};
	return dynamo.get(params).promise();
}

function postSqsMessage(body: FeederSqsMessage) {
	console.log('Posting message to SQS');
	const params: SendMessageRequest = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	sqs.sendMessage(params);
	return 'Success';
}