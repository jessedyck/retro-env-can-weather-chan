const Weather = require("ec-weather-js");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { exit } = require("process");
const path = require("path");
const { generatePlaylist, getPlaylist } = require("./generate-playlist.js");
const { generateCrawler, getCrawler } = require("./generate-crawler.js");
const { initCurrentConditions } = require("./current-conditions");
const { fetchWeatherForObservedCities, latestObservations } = require("./observations.js");
const { fetchWeatherForObservedUSCities, latestUSObservations } = require("./us-observations.js");
const { initManitobaTracking, manitobaHighLow } = require("./manitoba.js");
const historicalDataAPI = ({
  initHistoricalData,
  lastYearObservation,
  getSeasonPrecipData,
  getSeasonPrecipNormalsData,
  getLastMonthSummary,
} = require("./historical-data.js"));
const { fetchProvinceObservationData, getHotColdSpotsCanada } = require("./province-today-observation.js");
const { startAlertMonitoring } = require("./alert-monitoring");
const { initAQHIObservation, getAQHIObservation } = require("./aqhi-observation");
const { isWinterSeason } = require("./date-utils.js");

const corsOptions = {
  origin: "http://localhost:8080",
  optionsSuccessStatus: 200,
};
const app = express().use(cors(corsOptions));
const port = 8600;

let configHasSize = false;
const CONFIG_FILE = "./cfg/retro-evc-config.json";
let loadedConfig = null;
fs.stat(CONFIG_FILE, (err, stats) => {
  if (err) {
    console.error("No config file found, run setup first!");
    exit();
  } else configHasSize = stats.size > 0;

  // double check its not empty
  if (!configHasSize) {
    console.error("No config file found, run setup first!");
    exit();
  }

  // load it
  fs.readFile(CONFIG_FILE, "utf8", (err, data) => {
    if (err || !data || !data.length) {
      console.error("Config file has no data");
      exit();
    }

    const parsedJSON = JSON.parse(data);
    if (!parsedJSON) return;

    const primaryLocation = parsedJSON.primaryLocation;
    if (
      !primaryLocation.province ||
      !primaryLocation.province.length ||
      !primaryLocation.location ||
      !primaryLocation.location.length
    ) {
      console.error("Config file is corrupted");
      exit();
    }

    console.log(
      `Loading retro-envcan with primary location of ${primaryLocation.name || "N/A"} - ${primaryLocation.province}`
    );
    console.log(`Listening on ${port}...`);
    console.log(`Navigate to http://localhost:8600/ in your browser`);

    loadedConfig = parsedJSON;
    startBackend(parsedJSON);
  });
});

function startBackend(config) {
  // generate channel playlist from music folder
  generatePlaylist();

  // generate crawler messages
  generateCrawler();

  app.get("/api/init", (req, res) => {
    const playlist = getPlaylist();
    const crawler = getCrawler();
    res.send({
      playlist: { files: playlist, file_count: playlist.length },
      crawler: { messages: crawler, message_count: crawler.length },
      showMBHighLow: loadedConfig.showMBHighLow,
    });
  });

  // current conditions info
  initCurrentConditions(config?.primaryLocation, app, historicalDataAPI);

  // handling api requests
  fetchWeatherForObservedCities();
  setInterval(fetchWeatherForObservedCities, 5 * 60 * 1000);

  // us city observations
  fetchWeatherForObservedUSCities();
  setInterval(fetchWeatherForObservedUSCities, 7.5 * 60 * 1000);

  // air quality readings
  initAQHIObservation(config?.primaryLocation?.name);

  // MB regional high/low screen
  // winnipeg, portage, brandon, dauphin, kenora, thompson
  if (config.showMBHighLow) initManitobaTracking();

  // provincial today observations
  fetchProvinceObservationData(config?.primaryLocation?.province);
  setInterval(() => fetchProvinceObservationData(config?.primaryLocation?.province), 5 * 60 * 1000);

  const primaryLocation = config?.primaryLocation || {};
  // const capAlerts = getAlertsFromCAP();
  app.get("/api/weather2", (req, res) => {
    axios
      .get(
        `https://dd.weather.gc.ca/citypage_weather/xml/${primaryLocation.province}/${primaryLocation.location}_e.xml`
      )
      .then((resp) => {
        const weather = new Weather(resp.data);
        if (!weather) return;

        res.send({
          location: weather.all.location,
          current: weather.current,
          riseSet: weather.all.riseSet,
          observed: weather.date,
          upcomingForecast: weather.weekly,
          regionalNormals: weather.all.regionalNormals,
          warnings: capAlerts || [],
          almanac: weather.all.almanac,
          airQuality: getAQHIObservation(),
          last_year: lastYearObservation(),
          hot_cold: getHotColdSpotsCanada(),
          isWinter: isWinterSeason(),
        });
      })
      .catch(() => {
        res.sendStatus(404);
      });
  });

  app.get("/api/climate/season/precip", (req, res) => {
    res.send({
      isWinter: isWinterSeason(),
      totalPrecip: getSeasonPrecipData(),
      normalPrecip: getSeasonPrecipNormalsData(),
    });
  });

  app.get("/api/climate/lastmonth", (req, res) => {
    res.send({
      summary: getLastMonthSummary() || false,
    });
  });

  app.get("/api/weather/surrounding", (req, res) => {
    res.send({ observations: latestObservations });
  });

  app.get("/api/weather/usa", (req, res) => {
    res.send({ observations: latestUSObservations });
  });

  app.get("/api/weather/mb_highlow", (req, res) => {
    if (!loadedConfig.showMBHighLow) return;
    res.send(manitobaHighLow());
  });

  // start the amqp alert monitoring of cap
  startAlertMonitoring(config?.primaryLocation?.name, app);
}

app.listen(port);
app.use(express.static("dist"));
app.use(express.static("music"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "/dist/index.html"));
});

app.get("/music/*", (req, res) => {
  res.sendFile(path.join(__dirname, decodeURI(req.url)));
});
