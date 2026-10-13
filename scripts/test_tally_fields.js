async function testFields() {
    const xml = `<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>LedgersDetailed</ID>
    </HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
            <TDL>
                <TDLMESSAGE>
                    <COLLECTION NAME="LedgersDetailed">
                        <TYPE>Ledger</TYPE>
                        <NATIVEMETHOD>Name, LedgerMobile, LedgerPhone, LedgerContact, Parent, ClosingBalance</NATIVEMETHOD>
                        <FETCH>Name, LedgerMobile, LedgerPhone, LedgerContact, Parent, ClosingBalance, Email, Narration</FETCH>
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
    console.log('Result:\n', txt);
}

testFields().catch(console.error);
