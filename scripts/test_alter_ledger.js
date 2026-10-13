async function alterLedger() {
    const xml = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER>
    <BODY>
        <DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC>
        <DATA>
            <TALLYMESSAGE xmlns:UDF="TallyUDF">
                <LEDGER NAME="Abc" ACTION="Alter">
                    <NAME.LIST><NAME>Abc</NAME></NAME.LIST>
                    <LEDGERMOBILE>919135779897</LEDGERMOBILE>
                    <LEDGERPHONE>918235066919</LEDGERPHONE>
                    <CONTACTPERSON>Customer Account</CONTACTPERSON>
                </LEDGER>
            </TALLYMESSAGE>
        </DATA>
    </BODY>
</ENVELOPE>`;

    const res = await fetch('http://localhost:9000', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml
    });
    const txt = await res.text();
    console.log('Result:', txt.includes('<ALTERED>1</ALTERED>') ? 'SUCCESS' : 'FAILED');
}

alterLedger().catch(console.error);
