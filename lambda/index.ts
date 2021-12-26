import AWS from 'aws-sdk';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { GetItemInput, ScanInput } from 'aws-sdk/clients/dynamodb';
const sqs = new AWS.SQS;
const dynamo = new AWS.DynamoDB.DocumentClient;
declare var feederQueueUrl;

export const handler: APIGatewayProxyHandler = async (event, context) => {
    //console.log('Received event:', JSON.stringify(event, null, 2));

    let body;
    let statusCode = '200';
    const headers = {
        'Content-Type': 'application/json',
    };
    
    try {
        switch (event.resource as FeederApis) {
            case 'activate':
                break;
			case 'list-info':
				body = await getFeederList();
				break;
			case 'skip':
				break;
			case 'toggle-enabled':
				break;
            
            default:
        }
    }

    // try {
    //     switch (event.httpMethod) {
    //         case 'DELETE':
    //             body = await dynamo.delete(JSON.parse(event.body)).promise();
    //             break;
    //         case 'GET':
    //             body = await dynamo.scan({ TableName: event.queryStringParameters.TableName }).promise();
    //             break;
    //         case 'POST':
    //             body = await dynamo.put(JSON.parse(event.body)).promise();
    //             break;
    //         case 'PUT':
    //             body = await dynamo.update(JSON.parse(event.body)).promise();
    //             break;
    //         default:
    //             throw new Error(`Unsupported method "${event.httpMethod}"`);
    //     }
    // } catch (err) {
    //     statusCode = '400';
    //     body = err.message;
    // } finally {
    //     body = JSON.stringify(body);
    // }

    return {
        statusCode,
        body,
        headers,
    };
};

async function getFeederList() {
	const params: ScanInput = {
		TableName: 'feeders'
	}
	return dynamo.scan(params).promise();
}

type FeederApis = 'activate' | 'list-info' | 'skip' | 'toggle-enabled';