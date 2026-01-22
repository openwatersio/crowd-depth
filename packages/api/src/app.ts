import express from "express";
import { createApi } from "./api.js";
import rootLogger from "./logger.js";
import { pinoHttp } from "pino-http";

const app = express();

app.use(pinoHttp({ logger: rootLogger }));
app.use(createApi());

export default app;
