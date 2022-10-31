import * as fs from 'fs/promises';
const filePath = './dist/lambda/index.js';

try {
	let data;
	fs.readFile(filePath, { encoding: 'utf-8' }).then(res => {
		data = res.replaceAll('require("', 'require("/opt/node_modules/');
		fs.writeFile(filePath, data);
	});
} catch (e) {
	console.error('Error updating lambda layer module paths', e);
}