# Crowd Depth

Collect and share depth data from your marine vessel with crowd-sourced bathymetry programs.

## What's here

- [Signal K Plugin](packages/signalk-plugin/README.md) – collects your depth + position and periodically reports to the API.
- [API](packages/api/README.md) – a minimal web service for receiving bathymetry reports, storing them, and forwarding them NOAA.

## Frequently Asked Questions

### What data is collected?

The Signal K plugin collects depth (`environment.depth.*`), GPS position (`navigation.position`), and the current timestamp. You can chose to include your vessel's name and MMSI, or share that data anonymously—which will use a randomly generated UUID.

### How do I access the data?

NOAA publishes crowdsourced bathymetry through a [data archive](https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/docs/readme.html) and a [web viewer](https://www.ncei.noaa.gov/maps/iho_dcdb/).

All data collected by this plugin [will be publicly available soon](https://github.com/openwatersio/crowd-depth/issues/40).

### What license is applied to the data?

All collected data is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

---

See [NOAA's Crowdsourced Bathymetry Frequently Asked Questions](https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/docs/FAQ.html) for more.

## Contributing

- Install deps: `npm install`
- Run tests: `npm test`
- Build all packages: `npm run build`
- Run the API locally (defaults to http://localhost:3001): `npm start`

## Resources

- [IHO Guidance to Crowdsourced Bathymetry](https://iho.int/uploads/user/pubs/bathy/B_12_CSB-Guidance_Document-Edition_3.0.0_Final.pdf)
- [Guidance for Submitting Crowdsourced Bathymetry Data](https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/GuidanceforSubmittingCSBDataToTheIHODCDB%20%281%29.pdf)
- [Crowdsourced Bathymetry File Formats for Submission to the IHO Data Center for Digital Bathymetry](https://www.ncei.noaa.gov/sites/default/files/2024-04/SampleCSBFileFormats.pdf)
- [Workshop on Crowdsourced Bathemtry (2024)](https://iho.int/uploads/user/Inter-Regional%20Coordination/CSBWG/CSBWG_IRCC_CSB_Workshop/IRCC_CSB_workshop_April24_Master.pdf)
- [IHO Crowdsourced Bathymetry Trusted Node Agreement](https://www.ncei.noaa.gov/sites/default/files/2024-04/IHOCSBTrustedNodeAgreementFormTemplate.pdf)
