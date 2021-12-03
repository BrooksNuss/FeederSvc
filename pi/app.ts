import {Consumer} from 'sqs-consumer';
import AWS from 'aws-sdk';
import { Agent } from 'https';

const app = Consumer.create({
    queueUrl: '',
    handleMessage: async (message) => {
        //TODO: add some handlers here and there
    },
    sqs: new AWS.SQS({
        httpOptions: {
            agent: new Agent({
                keepAlive: true
            })
        }
    })
});

app.on('error', (err) => {
    console.error(err.message);
});

app.on('processing_error', (err) => {
    console.error(err.message);
})

app.start();