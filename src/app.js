const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const engagementRoutes = require("./routes/engagementRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Engagement service: engagements per client per period, the services
 * engaged with their fees, and the payments received — configured by the
 * organization's profession bundle.
 */
const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(healthRoutes);
app.use(engagementRoutes);

module.exports = app;
