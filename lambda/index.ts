import { APIGatewayProxyHandler } from 'aws-lambda';
import { SQS, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, GetCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { FeederApiResources, FeederSqsMessage } from '../models/FeederSqsMessage';
import { FeederInfo } from '../models/FeederInfo';
const sqs = new SQS({});
const dynamoClient = DynamoDBDocument.from(new DynamoDB({}));
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
		const fields = event.body ? JSON.parse(event.body) : null;
		const feeder = id ? await getFeeder(id) : null;

		switch (event.resource as FeederApiResources) {
		case '/activate/{id}':
			if (!feeder) {
				throw `Could not find feeder with id [${id}]`;
			}
			console.log('Received activate message for feeder {%s}', id);
			if (feeder.status === 'OFFLINE') {
				throw `Feeder [${id}] is offline`;
			} else {
				try {
					await postSqsMessage({id, type: 'activate'});
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
			if (!feeder) {
				throw `Could not find feeder with id [${id}]`;
			}
			console.log('Received skip message for feeder {%s}', id);
			if (feeder.status === 'OFFLINE') {
				throw `Feeder [${id}] is offline`;
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
			if (!feeder) {
				throw `Could not find feeder with id [${id}]`;
			}
			console.log('Received toggle message for feeder {%s}', id);
			try {
				await postSqsMessage({id, type: 'toggle-enabled'});
				body = 'Success';
			} catch(e) {
				console.error(e);
				body = 'Error posting SQS message: ' + e;
			}
			break;
		case '/update/{id}':
			if (!feeder) {
				throw `Could not find feeder with id [${id}]`;
			}
			console.log('Received update message for feeder {%s}', id);
			try {
				await postSqsMessage({id, type: 'update', fields });
				body = 'Success';
			} catch(e) {
				console.error(e);
				body = 'Error posting SQS message: ' + e;
			}
			break;
		case '/postaction/{id}':
			// stuff goes here for handling db updates/websocket updates. called directly from the feeder.
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
	return (await queryResult).Items as unknown as FeederInfo[];
}

async function getFeeder(id: string): Promise<FeederInfo> {
	console.log('Fetching feeder by id: ' + id);
	const params: GetCommandInput = {
		TableName: 'feeders',
		Key: { id: id }
	};
	const queryResult = await dynamoClient.get(params);
	return queryResult.Item as unknown as FeederInfo;
}

async function postSqsMessage(body: FeederSqsMessage) {
	console.log('Posting message to SQS');
	const params: SendMessageCommandInput = {
		QueueUrl: feederQueueUrl || '',
		MessageBody: JSON.stringify(body)
	};
	return sqs.sendMessage(params);
}