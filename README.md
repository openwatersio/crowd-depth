# Crowd Depth

Collect and share depth data from your marine vessel with crowd-sourced bathymetry programs.

## What's here

- [Signal K Plugin](packages/signalk-plugin/README.md) – collects your depth + position and periodically reports to the API.
- [API](packages/api/README.md) – a minimal web service for receiving bathymetry reports, storing them, and forwarding them NOAA.

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
- [Data Center for Digital Bathymetry Viewer](https://www.ncei.noaa.gov/maps/iho_dcdb/)
- [Accessing the data archive](https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/docs/readme.html)
