const setupDb = require('./database.js');
console.log("Starting database test...");

setupDb()
	.then(() => {
		console.log("SUCCESS: your database.js compiled and ran with zero errors!");
		process.exit(0);
	})

	.catch((error) => {
		console.error("FAILURE: A syntax error or typo was found!");
		console.error(error);
		process.exit(1);
	});
