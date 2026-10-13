import { testTallyConnection, findLedgerByPhone } from '../tally_engine.js';

async function main() {
    // 1. Fetch open companies
    const res = await fetch('http://localhost:9000', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: `<ENVELOPE>
            <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER>
            <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
            <TDL><TDLMESSAGE><COLLECTION NAME="CompanyColl"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY>
        </ENVELOPE>`
    });
    const xml = await res.text();
    console.log('--- COMPANIES XML ---');
    console.log(xml.slice(0, 1500));

    // 2. Fetch list of ledgers
    const resLedgers = await fetch('http://localhost:9000', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: `<ENVELOPE>
            <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Ledgers</ID></HEADER>
            <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
            <TDL><TDLMESSAGE><COLLECTION NAME="LedgerColl"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name, LedgerMobile, LedgerPhone</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY>
        </ENVELOPE>`
    });
    const xmlLedgers = await resLedgers.text();
    console.log('--- LEDGERS XML (sample) ---');
    console.log(xmlLedgers.slice(0, 2500));
}

main().catch(console.error);
