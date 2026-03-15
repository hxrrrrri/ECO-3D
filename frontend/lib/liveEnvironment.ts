export interface LiveEnvironmentSnapshot {
  windSpeedMs: number;
  windDirectionDeg: number;
  windDirectionCardinal: string;
  isDay: boolean;
  timezone: string;
  fetchedAtIso: string;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
}

const CARDINAL_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

const degToRad = (deg: number) => (deg * Math.PI) / 180;
const radToDeg = (rad: number) => (rad * 180) / Math.PI;

const clampDegrees = (deg: number) => {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
};

const julianDay = (date: Date): number => date.getTime() / 86400000 + 2440587.5;

export const directionDegreesToCardinal = (degrees: number): string => {
  const normalized = clampDegrees(degrees);
  return CARDINAL_16[Math.round(normalized / 22.5) % 16];
};

export const computeSunPosition = (
  date: Date,
  latitude: number,
  longitude: number
): { azimuthDeg: number; elevationDeg: number } => {
  // NOAA-style solar position approximation in UTC.
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525.0;

  const geomMeanLong = clampDegrees(
    280.46646 + t * (36000.76983 + t * 0.0003032)
  );
  const geomMeanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const anomRad = degToRad(geomMeanAnom);
  const sunEqCenter =
    Math.sin(anomRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * anomRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * anomRad) * 0.000289;

  const sunTrueLong = geomMeanLong + sunEqCenter;
  const omega = 125.04 - 1934.136 * t;
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(degToRad(omega));

  const meanObliq =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(degToRad(omega));

  const obliqRad = degToRad(obliqCorr);
  const appLongRad = degToRad(sunAppLong);

  const declinationRad = Math.asin(Math.sin(obliqRad) * Math.sin(appLongRad));

  const y = Math.tan(obliqRad / 2) ** 2;
  const eqTimeMinutes =
    4 *
    radToDeg(
      y * Math.sin(2 * degToRad(geomMeanLong)) -
      2 * eccentricity * Math.sin(anomRad) +
      4 * eccentricity * y * Math.sin(anomRad) * Math.cos(2 * degToRad(geomMeanLong)) -
      0.5 * y * y * Math.sin(4 * degToRad(geomMeanLong)) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * anomRad)
    );

  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (utcMinutes + eqTimeMinutes + 4 * longitude + 1440) % 1440;

  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) {
    hourAngle += 360;
  }

  const latRad = degToRad(latitude);
  const hourRad = degToRad(hourAngle);

  const cosZenith =
    Math.sin(latRad) * Math.sin(declinationRad) +
    Math.cos(latRad) * Math.cos(declinationRad) * Math.cos(hourRad);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = 90 - radToDeg(zenith);

  const azimuthRaw = radToDeg(
    Math.atan2(
      Math.sin(hourRad),
      Math.cos(hourRad) * Math.sin(latRad) - Math.tan(declinationRad) * Math.cos(latRad)
    )
  );
  const azimuth = clampDegrees(azimuthRaw + 180);

  return {
    azimuthDeg: azimuth,
    elevationDeg: elevation,
  };
};

export const fetchLiveEnvironment = async (
  latitude: number,
  longitude: number
): Promise<LiveEnvironmentSnapshot> => {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", "wind_speed_10m,wind_direction_10m,is_day");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    current?: {
      wind_speed_10m?: number;
      wind_direction_10m?: number;
      is_day?: number;
      time?: string;
    };
    timezone?: string;
  };

  const windSpeedMs = Number(payload.current?.wind_speed_10m ?? 0);
  const windDirectionDeg = clampDegrees(Number(payload.current?.wind_direction_10m ?? 0));
  const cardinal = directionDegreesToCardinal(windDirectionDeg);

  const now = new Date();
  const { azimuthDeg, elevationDeg } = computeSunPosition(now, latitude, longitude);

  return {
    windSpeedMs,
    windDirectionDeg,
    windDirectionCardinal: cardinal,
    isDay: Number(payload.current?.is_day ?? 0) === 1,
    timezone: payload.timezone ?? "UTC",
    fetchedAtIso: payload.current?.time ?? now.toISOString(),
    sunAzimuthDeg: azimuthDeg,
    sunElevationDeg: elevationDeg,
  };
};
