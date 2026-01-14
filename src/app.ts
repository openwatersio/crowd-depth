import express from "express";
import { createApi } from "./api.js";
import logger from "express-requests-logger";

const app = express();
app.use(logger());
app.use(createApi());

export default app;
