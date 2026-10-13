async function dumpAllLedgers() {
    const xml = `<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>AllLedgers</ID>
    </HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
            <TDL>
                <TDLMESSAGE>
                    <COLLECTION NAME="AllLedgers">
                        <TYPE>Ledger</TYPE>
                        <FETCH>Name, LedgerMobile, LedgerPhone, MobileNo, Phone, Parent, PartyMobile, ContactPerson, ClosingBalance</FETCH>
                    </COLLECTION>
                </TDLMESSAGE>
            </TDL>
        </DESC>
    </BODY>
</ENVELOPE>`;

    const res = await fetch('http://localhost:9000', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml
    });
    const txt = await res.text();
    console.log('Full Ledgers XML:');
    console.log(txt);
}

dumpAllLedgers().catch(console.error);
