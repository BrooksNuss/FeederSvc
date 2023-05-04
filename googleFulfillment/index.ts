// Import the appropriate service
import { JsonObject, SmartHomeV1ExecuteResponseCommands, SmartHomeV1SyncDevices, SmartHomeV1SyncResponse, smarthome } from 'actions-on-google';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { APIGatewayProxyHandler } from 'aws-lambda/trigger/api-gateway-proxy';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { BatchGetCommandInput, DynamoDBDocument, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { FeederInfo } from '../models/FeederInfo';
import { UpdateFields } from '../models/FeederSqsMessage';
import axios from 'axios';
import { aws4Interceptor } from 'aws4-axios';
import { fromEnv } from '@aws-sdk/credential-providers';

const dynamoClient = DynamoDBDocument.from(new DynamoDB({}));
const feederApiUrl = process.env.FEEDER_API_URL;

// Create an app instance
const app = smarthome({debug: true});

app.onExecute(async (body, headers) => {
	console.log('execute');
	const devices = body.inputs[0].payload.commands[0].devices;
	const commands = body.inputs[0].payload.commands[0].execution;
	const ids: string[] = [];
	const requests: Array<Promise<any>> = [];
	const formattedResults: SmartHomeV1ExecuteResponseCommands[] = [];
	if (commands[0].command === 'action.devices.commands.Dispense') {
		devices.forEach(async device => {
			requests.push(activateFeeder(device.id));
		});
	} else if (commands[0].command === 'action.devices.commands.OnOff') {
		if (commands[0].params?.on === true) {
			devices.forEach(async device => {
				requests.push(updateFeeder(device.id, { enabled: true }));
			});
		} else if (commands[0].params?.on === false) {
			devices.forEach(async device => {
				requests.push(updateFeeder(device.id, { enabled: false }));
			});
		}
	} else if (commands[0].command === 'action.devices.commands.StartStop') {
		if (commands[0].params?.start === true) {
			devices.forEach(async device => {
				requests.push(activateFeeder(device.id));
			});
		} else {
			devices.forEach(async device => {
				formattedResults.push({ ids: [device.id], status: 'SUCCESS' });
			});
		}
	}
	console.log('awaiting promise');
	const results = await Promise.allSettled<ActivateResponse>(requests);
	results.forEach(res => {
		if (res.status === 'fulfilled') {
			//Add more error handling here. Include error reason
			formattedResults.push({ ids: [res.value.id], status: res.value.status === 200 ? 'SUCCESS' : 'ERROR' });
		}
	});
	console.log('FINAL EXECUTE RESULTS:');
	console.log(formattedResults);
	return {
		requestId: body.requestId,
		payload: {
			commands: formattedResults.map(res => {
				return { 
					ids: res.ids,
					status: res.status,
					states: {
						isRunning: false,
						isPaused: false
					}
				};
			})
		},
	};
});

app.onQuery(async (body, headers) => {
	console.log('query');
	console.log(body);
	const ids: Record<string, string>[] = body.inputs[0].payload.devices.map(device => {
		return { id: device.id };
	});
	const params: BatchGetCommandInput = {
		RequestItems: {
			feeders: {
				Keys: ids
			}
		}
	};
	const queryResult = dynamoClient.batchGet(params);
	const items = (await queryResult).Responses;
	const devices: JsonObject = {};
	console.log(items);
	if (items) {
		(items.feeders as FeederInfo[]).forEach(feeder => {
			devices[(feeder.id as string)] = {
				online: true,
				status: 'SUCCESS',
				dispenseItems: [
					{
						itemName: 'cat_food_key',
						amountRemaining: {
							amount: feeder.estRemainingFood,
							unit: 'NO_UNITS'
						},
						amountLastDispensed: {
							amount: 1,
							unit: 'NO_UNITS'
						},
						isCurrentlyDispensing: false
					}
				],
				isRunning: false,
				isPaused: false,
				on: feeder.enabled
			};
		});
	}
	console.log('final devices');
	console.log(devices);

	return {
		requestId: body.requestId,
		payload: {
			devices
		},
	};
});

app.onSync(async (body, headers) => {
	console.log('sync');
	console.log(body);

	const params: ScanCommandInput = {
		TableName: 'feeders'
	};
	const queryResult = dynamoClient.scan(params);
	const items = (await queryResult).Items as FeederInfo[];
	const devices: SmartHomeV1SyncDevices[] = [];
	items.forEach(feeder => {
		devices.push(
			{
				id: feeder.id,
				type: 'action.devices.types.PETFEEDER',
				traits: [
					'action.devices.traits.Dispense',
					'action.devices.traits.OnOff',
					'action.devices.traits.StartStop'
				],
				name: {
					defaultNames: [feeder.name],
					name: feeder.name,
					nicknames: [feeder.name]
				},
				deviceInfo: {
					manufacturer: 'bn38',
					model: 'cat-feeder',
					hwVersion: '1.0',
					swVersion: '1.0.1'
				},
				willReportState: false
			}
		);
	});

	const response: SmartHomeV1SyncResponse = {
		requestId: body.requestId,
		payload: {
			devices
		}
	};

	return response;
});

const auth = (request: APIGatewayProxyEvent): APIGatewayProxyResult => {
	//dummy auth
	console.log('auth function');
	if (!request.queryStringParameters?.redirect_uri || !request.queryStringParameters?.state) {
		console.error('Missing redirect_uri or state in query string params for auth');
		return {
			statusCode: 400,
			body: 'Missing query params for redirect_uri or state'
		};
	}
	// const responseurl = util.format('%s?code=%s&state=%s',
	// 	decodeURIComponent(request.queryStringParameters.redirect_uri), 'xxxxxx',
	// 	request.queryStringParameters.state);
	const responseurl = `${request.queryStringParameters.redirect_uri}?code=xxxxxx&state=${request.queryStringParameters.state}&access_token=${'YEEHAWACCESSTOKEN'}&token_type=bearer`;
	console.log(`Set redirect as ${responseurl}`);
	return {
		statusCode: 302,
		headers: {
			Location: responseurl
		},
		body: 'redirecting...'
	};
};
  
const token = (request: APIGatewayProxyEvent): APIGatewayProxyResult => {
	//dummy token
	console.log('token function');
	let grantType;
	const bodyParams: JsonObject = {};
	if (request.queryStringParameters?.grant_type) {
		grantType = request.queryStringParameters.grant_type;
	} else if (request.body) {
		const parameters = request.body.split('&');
		parameters.forEach(parameter => {
			const pair = parameter.split('=');
			bodyParams[pair[0]] = pair[1];
		});
		grantType = bodyParams['grant_type'];
	}
	if (!grantType) {
		if (!request.body) {
			console.error('Missing grant_type in query string params and body for token!');
			return {
				statusCode: 400,
				body: 'Missing grant_type'
			};
		}
		const body = JSON.parse(request.body);
		grantType = body.grant_type;
	}
	const secondsInDay = 86400; // 60 * 60 * 24
	const HTTP_STATUS_OK = 200;
	console.log(`Grant type ${grantType}`);
  
	let obj;
	if (grantType === 'authorization_code') {
		obj = {
			token_type: 'bearer',
			access_token: '123access',
			refresh_token: '123refresh',
			expires_in: secondsInDay,
		};
	} else if (grantType === 'refresh_token') {
		obj = {
			token_type: 'bearer',
			access_token: '123access',
			expires_in: secondsInDay,
		};
	}
	return {
		statusCode: HTTP_STATUS_OK,
		body: JSON.stringify(obj)
	};
};

// export const fulfillment = app;
export const handler: APIGatewayProxyHandler = async (event) => {
	console.log('handler');
	console.log(event);

	let res: APIGatewayProxyResult = {
		statusCode: 200,
		body: '{}',
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin' : '*'
		}
	};
	let handledFulfillment;
	switch (event.path) {
		case '/google-fulfillment/auth':
			res = auth(event);
			break;
		case '/google-fulfillment/token':
			res = token(event);
			break;
		case '/google-fulfillment/fulfillment':
			//transform request body to expected format
			if (!event.body) {
				console.error('Missing request body in fulfillment!');
			} else {
				handledFulfillment = await app.handler(JSON.parse(event.body), event.headers);
				console.log('handled fulfillment');
				console.log(handledFulfillment);
				res.body = JSON.stringify(handledFulfillment.body);
			}
	}

	console.log(res);
	return res;
};

async function activateFeeder(id: string): Promise<ActivateResponse> {
	const credentials = fromEnv();
	const interceptor = aws4Interceptor(
		{
			region: 'us-east-1',
			service: 'execute-api',
		},
		await credentials()
	);
	axios.interceptors.request.use(interceptor);

	const res = await axios.post(feederApiUrl + '/service-activate/' + id, {}, { headers: { 'activate-source': 'google' } });
	console.log('sent activate request');
	console.log(res);
	return { id, status: res.status };
}

async function updateFeeder(id: string, fields: UpdateFields): Promise<ActivateResponse> {
	const credentials = fromEnv();
	const interceptor = aws4Interceptor(
		{
			region: 'us-east-1',
			service: 'execute-api',
		},
		await credentials()
	);
	axios.interceptors.request.use(interceptor);

	const res = await axios.post(feederApiUrl + '/service-update/' + id, fields, { headers: { 'update-source': 'google' } });
	console.log('sent activate request');
	console.log(res);
	return { id, status: res.status };
}

type ActivateResponse = { id: string, status: number };