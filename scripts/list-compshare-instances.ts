import {config} from '../server/config.js';
import {CompshareInstanceController} from '../server/compshare.js';

if (!config.compshare.publicKey || !config.compshare.privateKey) {
  throw new Error('请设置 COMPSHARE_PUBLIC_KEY 和 COMPSHARE_PRIVATE_KEY');
}

const baseOptions = {...config.compshare, instanceId: config.compshare.instanceId || 'discover'};
const controller = new CompshareInstanceController(baseOptions);
const supportZones = await controller.listSupportZones();
const locations = supportZones.length
  ? supportZones
  : [{region: config.compshare.region, zone: config.compshare.zone, name: ''}];
const uniqueLocations = new Map(locations.map((item) => [`${item.region}/${item.zone}`, item]));
const discovered = await Promise.all(
  [...uniqueLocations.values()].map(async (location) => {
    const regional = new CompshareInstanceController({...baseOptions, region: location.region, zone: location.zone});
    const instances = await regional.listInstances();
    return instances.map((instance) => ({...instance, region: location.region, zone: location.zone}));
  }),
);
const instances = discovered.flat();
console.log(
  JSON.stringify(
    instances.map(({id, name, state, gpuType, gpuCount, hourlyPrice, region, zone}) => ({
      id,
      name,
      state,
      gpuType,
      gpuCount,
      hourlyPrice,
      region,
      zone,
    })),
    null,
    2,
  ),
);
