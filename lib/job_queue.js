const amqp = require("amqplib");

const AMQP_HOST = process.env.AMQP_HOST || "rabbitmq";
const AMQP_PORT = process.env.AMQP_PORT || "5672";
const AMQP_USER = process.env.AMQP_USER || "leadgpt";
const AMQP_PASS = process.env.AMQP_PASS || "poiulkjh";

const AMQP_ENDPOINT = `amqp://${AMQP_USER}:${AMQP_PASS}@${AMQP_HOST}:${AMQP_PORT}`;
// const AMQP_ENDPOINT = process.env.AMQP_ENDPOINT || "amqp://localhost";

let conn;
let config = {
  channel: null,
};

const queue_set = new Set();

const create_connection = async () => {
  try {
    conn = await amqp.connect(AMQP_ENDPOINT);

    // create a channel to the RabbitMQ server
    config.channel = await conn.createChannel();
  } catch (err) {
    console.error("AMQP Error: (create_conn) (job_queue): ", err);
    throw err;
  }
};

const ensure_queue = async (queue_name) => {
  try {
    if (queue_set.has(queue_name)) {
      return true;
    }

    await config.channel.assertQueue(queue_name);

    // assume a queue has been created
    queue_set.add(queue_name);
    return true;
  } catch (err) {
    console.error("AMQP Error: (get_queue) (job_queue): ", err);
    throw err;
  }
};

const publish = async (queue, jobID, msg) => {
  if (!config.channel) {
    console.error(
      "AMQP Error: (publish) (job_queue): Channel has not been established.",
    );
    throw new Error(`Create a connection, abd a channel first to publish`);
  }

  if (!queue_set.has(queue)) {
    console.error(
      "AMQP Error: (publish) (job_queue): Queue has not been initialized",
    );
    throw new Error(
      `Queue has not been created in RabbitMQ server. run ensure_queue(${queue}) first`,
    );
  }

  try {
    await config.channel.sendToQueue(
      queue,
      Buffer.from(
        JSON.stringify({
          jobID,
          message: msg,
        }),
      ),
    );
    console.info("Scheduled a job in queue: ", queue);
  } catch (err) {
    console.error("AMQP Error: (publish) (job_queue): ", err);
    throw err;
  }
};

const subscribe = async (queue, cb_func) => {
  //
  // * cb_func -> cb_func(message){} : will be called when a new message has been receibed from the queue
  //

  if (!config.channel) {
    console.error(
      "AMQP Error: (publish) (job_queue): Channel has not been established.",
    );
    throw new Error(`Create a connection, and a channel first to publish`);
  }

  if (!queue_set.has(queue)) {
    console.error(
      "AMQP Error: (publish) (job_queue): Queue has not been initialized",
    );
    throw new Error(
      `Queue has not been created in RabbitMQ server. run ensure_queue(${queue}) first`,
    );
  }

  try {
    config.channel.consume(queue, cb_func);
  } catch (err) {
    console.error("AMQP Error: (subscribe) (job_queue): ", err);
    throw err;
  }
};

// -----------------------------------------------------------------------------------------

// Initialization function
const init = async () => {
  await create_connection();
};

module.exports = {
  config,
  ensure_queue,
  publish,
  subscribe,
  init,
};
