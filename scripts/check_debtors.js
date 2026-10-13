async function checkDebtors() {
    const xml = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>DebtorsColl</ID></HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
            <TDL><TDLMESSAGE><COLLECTION NAME="DebtorsColl"><TYPE>Ledger</TYPE><CHILDVARIABLES>Parent: "Sundry Debtors"</CHILDVARIABLES><FETCH>Name, LedgerMobile, LedgerPhone, MobileNo, Phone, Parent, ClosingBalance</FETCH></COLLECTION></TDLMESSAGE></TDL>
        </DESC>
    </BODY>
</ENVELOPE>`;

    const res = await fetch('http://localhost:9000', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml
    });
    const txt = await res.text();
    console.log('Debtors XML:\n', txt);
}

checkDebtors().catch(console.error);
