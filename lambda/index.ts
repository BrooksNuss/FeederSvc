import AWS from 'aws-sdk';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanInput } from 'aws-sdk/clients/dynamodb';
import { SendMessageRequest } from 'aws-sdk/clients/sqs';
import { FeederApiResources, FeederSqsMessage } from './models/FeederSqsMessage';
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
		switch (event.resource as FeederApiResources) {
		case '/activate/{id}':
			body = await postSqsMessage({id, type: 'activate'});
			break;
		case '/list-info':
			body = await getFeederList();
			break;
		case '/skip/{id}':
			body = await postSqsMessage({id, type: 'skip'});
			break;
		case '/toggle-enabled/{id}':
			body = await postSqsMessage({id, type: 'toggle-enabled'});
			break;
			
		default:
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

async function postSqsMessage(body: FeederSqsMessage) {
	console.log('Posting message to SQS');
	const params: SendMessageRequest = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	return sqs.sendMessage(params).promise();
}