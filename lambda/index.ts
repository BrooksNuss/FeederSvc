import AWS from 'aws-sdk';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanInput } from 'aws-sdk/clients/dynamodb';
import { SendMessageRequest } from 'aws-sdk/clients/sqs';
import { FeederApiType, FeederSqsMessage } from '../models/FeederSqsMessage';
const sqs = new AWS.SQS;
const dynamo = new AWS.DynamoDB.DocumentClient;
declare let feederQueueUrl;

export const handler: APIGatewayProxyHandler = async (event, context) => {
	console.log('Received event:', JSON.stringify(event, null, 2));

	let body;
	let statusCode = 200;
	const headers = {
		'Content-Type': 'application/json',
	};
	
	try {
		const id = event.pathParameters.id;
		switch (event.resource as FeederApiType) {
			case 'activate':
				body = await postSqsMessage({id, type: 'activate'});
				break;
			case 'list-info':
				body = await getFeederList();
				break;
			case 'skip':
				body = await postSqsMessage({id, type: 'skip'});
				break;
			case 'toggle-enabled':
				body = await postSqsMessage({id, type: 'toggle-enabled'});
				break;
			
			default:
		}
	} catch (err) {
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
	const params: ScanInput = {
		TableName: 'feeders'
	};
	return dynamo.scan(params).promise();
}

async function postSqsMessage(body: FeederSqsMessage) {
	const params: SendMessageRequest = {
		QueueUrl: feederQueueUrl,
		MessageBody: JSON.stringify(body)
	};
	return sqs.sendMessage(params).promise();
}