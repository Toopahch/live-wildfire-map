/**
 * config.js
 * -----------------------------------------------------------------------------
 * Central configuration for Live Wildfire Map. Keeping data sources and tunables
 * in one place makes the app easy to retarget (e.g. a single state, a different
 * feed, or a faster refresh cadence) without touching application logic.
 *
 * All feeds are public, key-free, CORS-enabled REST endpoints, so the site runs
 * entirely client-side with no backend — it updates itself on every load and on
 * the refresh interval below.
 */
window.WF_CONFIG = Object.freeze({
  /* How often the dashboard re-pulls live data, in milliseconds (5 minutes). */
  refreshIntervalMs: 5 * 60 * 1000,

  /* ---------------------------------------------------------------------- *
   *  Supabase — powers the cached "Latest News & Updates" feature.
   *  Paste your Project URL + the public anon key (Settings → API).
   *  The anon key is safe to expose: Row Level Security limits it to reading
   *  visible news only. Leave blank to run the map without the news feature.
   * ---------------------------------------------------------------------- */
  supabase: {
    url: 'https://gvmbqgbswuthbfidnqof.supabase.co',
    anonKey: 'sb_publishable_rcumbPw2zCet7ugHkH5SdQ_cbkFVzlh' // publishable key — safe to expose (read-only via RLS)
  },

  /* Initial map framing — continental United States. */
  initialView: { center: [39.5, -98.35], zoom: 4 },
  maxFlyZoom: 9,

  /* Live incident points (name, size, % contained, cause, discovery time). */
  incidents: {
    url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query',
    params: {
      where: "IncidentTypeCategory='WF'",
      outFields: [
        'OBJECTID', 'IncidentName', 'IncidentSize', 'PercentContained',
        'POOState', 'POOCounty', 'FireCause', 'FireDiscoveryDateTime',
        'IncidentShortDescription', 'IrwinID'
      ].join(','),
      orderByFields: 'IncidentSize DESC',
      resultRecordCount: 2000,
      returnGeometry: true,
      geometryPrecision: 4, // ~11 m — plenty for point markers, much smaller payload
      outSR: 4326,
      f: 'geojson'
    }
  },

  /* Mapped fire perimeters (polygons) for large/established incidents. */
  perimeters: {
    url: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query',
    params: {
      where: '1=1',
      outFields: [
        'poly_IncidentName', 'attr_IncidentName', 'attr_IrwinID',
        'attr_PercentContained', 'attr_IncidentSize', 'poly_GISAcres'
      ].join(','),
      resultRecordCount: 2000,
      returnGeometry: true,
      maxAllowableOffset: 0.004, // simplify geometry for fast client rendering
      geometryPrecision: 4,      // trim full-precision doubles from the payload
      outSR: 4326,
      f: 'geojson'
    }
  },

  /* ---------------------------------------------------------------------- *
   *  SMOKE — where it is now, and where it's headed.
   *  All three feeds are public NOAA services: key-free and CORS-enabled.
   * ---------------------------------------------------------------------- */
  smoke: {
    /* Current smoke extent — NOAA HMS analyst-drawn plume polygons (Light/Medium/Heavy). */
    current: {
      url: 'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query',
      params: {
        where: '1=1',
        outFields: 'Density,Satellite',
        outSR: 4326,
        returnGeometry: true,
        maxAllowableOffset: 0.01, // advisory layer — coarse outlines are fine
        geometryPrecision: 4,
        f: 'geojson'
      }
    },

    /* Smoke FORECAST — NOAA HRRR-Smoke (NDGD) near-surface smoke, hourly to ~48h.
       ArcGIS ImageServer exposed as a time-enabled, transparent WMS overlay. */
    forecast: {
      wmsUrl: 'https://mapservices.weather.noaa.gov/raster/services/air_quality/ndgd_smoke_sfc_1hr_avg_time/ImageServer/WMSServer',
      metaUrl: 'https://mapservices.weather.noaa.gov/raster/rest/services/air_quality/ndgd_smoke_sfc_1hr_avg_time/ImageServer?f=json',
      layer: 'ndgd_smoke_sfc_1hr_avg_time',
      opacity: 0.7,
      frameStepMs: 60 * 60 * 1000, // hourly frames
      animationMs: 750            // play-mode frame duration
    },

    /* Surface wind (10 m), sampled on a uniform grid across the visible map so
       drift arrows appear evenly everywhere — including inside the smoke.
       Open-Meteo is free, key-free, CORS-enabled, and accepts many points/request. */
    wind: {
      url: 'https://api.open-meteo.com/v1/forecast',
      spacingPx: 88,   // target on-screen spacing between arrows (px)
      minCols: 5, maxCols: 16,
      minRows: 4, maxRows: 11
    }
  },

  /* Location search — OpenStreetMap Nominatim geocoder (free, key-free, CORS).
     Resolves ZIP codes, cities, counties, landmarks, addresses → lat/lon. */
  geocode: {
    url: 'https://nominatim.openstreetmap.org/search'
  },

  /* Base map layers. Esri World Imagery is the default satellite view. */
  basemaps: {
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 19
    },
    labels: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19
    },
    terrain: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19
    },
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 20,
      subdomains: 'abcd'
    }
  }
});
