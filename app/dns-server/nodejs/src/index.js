import request from 'request';
import dns2 from 'dns2';
const {createServer, Packet} = dns2;
import k8s from "@kubernetes/client-node";
import _ from "lodash";
import fs from "node:fs";
import path from "node:path";
import "node:util";
import process from "node:process";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const opts = {};
await kc.applyToRequest(opts);

const dnsPort = parseInt(process.env.DNS_PORT, 10) || 53;

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const DNS_NO_DATA_DELAY_MS_FILE = path.join(CONFIG_DIR, "dns-nodata-delay-ms");

// Initial value from environment
let dnsNoDataDelayMs;

async function readDnsNoDataDelayMs(reportNotFound) {
    try {
        const data = await fs.promises.readFile(DNS_NO_DATA_DELAY_MS_FILE, 'utf8');
        const newDelayMs = parseInt(data.trim(), 10);
        if ( ! isNaN(newDelayMs) && dnsNoDataDelayMs !== newDelayMs) {
            if (dnsNoDataDelayMs !== undefined) {
                console.log(`Updated NoData packet delay to ${newDelayMs} ms`);
            }
            dnsNoDataDelayMs = newDelayMs;
        }
        return true;    // File exists and is readable
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            if (reportNotFound) {
                console.error(`Configuration file ${DNS_NO_DATA_DELAY_MS_FILE} not found`);
            }
        }
        else {
            console.error(`Unable to read file ${DNS_NO_DATA_DELAY_MS_FILE}:`, err);
        }
        return false;   // File does not exist or is not readable
    }
}

function setFileWatch(abortController, finished) {
    try {
        const watchOptions = {signal: abortController.signal, persistent: false};
        fs.watch(DNS_NO_DATA_DELAY_MS_FILE, watchOptions, async (eventType) => {
            if (eventType === "rename") {
                // Renamed/removed - stop watching and install new watcher
                abortController.abort();
                setFileWatch(new AbortController(), async () => {
                    await readDnsNoDataDelayMs(false);
                });
            }
            else {
                await readDnsNoDataDelayMs(false);
            }
        });
        finished();
    }
    catch (err) {
        // Retry in 1 second
        setTimeout(() => setFileWatch(abortController, finished), 1000);
    }
}

// Initial read of configuration and start of watching for changes
if (await readDnsNoDataDelayMs(process.env.DNS_NODATA_DELAY_MS === undefined)) {
    setFileWatch(new AbortController(), () => {
        console.log(`Watching config file ${DNS_NO_DATA_DELAY_MS_FILE} for changes`)
    });
}

// Initial value from environment in case parsing failed
if (dnsNoDataDelayMs === undefined) {
    dnsNoDataDelayMs = parseInt(process.env.DNS_NODATA_DELAY_MS || "0", 10) || 0;
}

// See https://tools.ietf.org/html/rfc1034#section-4.3.3
const wildcardRegex = new RegExp('^[*][.](?<anydomain>[^*]+)$');

const respond = (dnsRequest, dnsResponseSend) => {

    console.log("Request:", JSON.stringify(dnsRequest));

    const names = [];
    for (let i = 0; i < dnsRequest.questions.length; i++) {
        if (dnsRequest.questions[i].type === Packet.TYPE.ANY
                || dnsRequest.questions[i].type === Packet.TYPE.A) {
            const name = dnsRequest.questions[i].name;
            names.push(name);
        }
    }

    request.get(`${kc.getCurrentCluster().server}/apis/networking.k8s.io/v1/ingresses`, opts, (error, response, jsonBody) => {

        const confirmedNames = [];

        const body = JSON.parse(jsonBody);
        for (let i = 0; i < body.items.length; i++) {
            const ingress = body.items[i];
            const rules   = ingress.spec.rules;
            if (rules) {
                for (let k = 0; k < rules.length; k++) {
                    const rule = rules[k];
                    const host = rule.host;
                    if (typeof host === "undefined") {
                        continue;
                    }
                    if (names.includes(host)) {
                        confirmedNames.push(host);
                    }
                    else {
                        const match = host.match(wildcardRegex);
                        if (match) {
                            const hostRegex = new RegExp(`[^*]+[.]${_.escapeRegExp(match.groups.anydomain)}`);
                            for (const name of names) {
                                if (name.match(hostRegex)) {
                                    confirmedNames.push(name);
                                }
                            }
                        }
                    }
                }
            }
        }

        console.log('Confirmed names:', JSON.stringify(confirmedNames));

        const dnsResponse     = Packet.createResponseFromRequest(dnsRequest);
        dnsResponse.header.ra = 1;

        for (let i = 0; i < confirmedNames.length; i++) {
            dnsResponse.answers.push({
                address: process.env.POD_IP,
                type   : Packet.TYPE.A,
                class  : Packet.CLASS.IN,
                ttl    : 300,
                name   : confirmedNames[i]
            });
        }

        if (confirmedNames.length > 0 || dnsNoDataDelayMs === 0) {
            console.log("Direct response:", JSON.stringify(dnsResponse));
            dnsResponseSend(dnsResponse);
        } else {
            // Delay NoData in case multiple DNS servers are asked for the response
            setTimeout(() => {
                console.log(`Delayed response (${dnsNoDataDelayMs} ms):`, JSON.stringify(dnsResponse));
                dnsResponseSend(dnsResponse);
            }, dnsNoDataDelayMs);
        }
    });
};

// noinspection JSValidateTypes
const server = createServer({udp: true, handle: respond});
server.on('listening', () => {
    const addresses = server.addresses();
    console.log(`Listening to ${addresses.udp.address} on port ${addresses.udp.port} and NoData packet delay ${dnsNoDataDelayMs} ms`);
});

await server.listen({udp: {port: dnsPort, address: process.env.POD_IP, type: "udp4"}});

await new Promise(resolve => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
});

await server.close();

console.log('Closed');
