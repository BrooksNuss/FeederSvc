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
				try {
					await postSqsMessage({id, type: 'activate'});
					// Make db update here. await it and return the new db item instead of just success
					body = 'Success';
				} catch(e) {
					console.error(e);
					body = 'Error posting SQS message: ' + e;
				}
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
				try {
					await postSqsMessage({id, type: 'skip'});
					body = 'Success';
				} catch(e) {
					console.error(e);
					body = 'Error posting SQS message: ' + e;
				}
			}
			break;
		case '/toggle-enabled/{id}':
			console.log('Received toggle message for feeder {%s}', id);
			try {
				await postSqsMessage({id, type: 'toggle-enabled'});
				body = 'Success';
			} catch(e) {
				console.error(e);
				body = 'Error posting SQS message: ' + e;
			}
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
	// key type in docs is different from what the sdk expects. type should be GetItemInput
	const params = {
		TableName: 'feeders',
		Key: {id}
	};
	return dynamo.get(params).promise();
}

async function postSqsMessage(body: FeederSqsMessage) {
	console.log('Posting message to SQS');
	const params: SendMessageRequest = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	return sqs.sendMessage(params).promise();
}