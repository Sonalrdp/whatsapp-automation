import 'dotenv/config';
import mysql from 'mysql2/promise';

async function testConnection() {
    console.log('--- TiDB Cloud / MySQL Connection Diagnostic ---');
    console.log('Environment Variables detected:');
    console.log('  DB_HOST:', process.env.DB_HOST ? `"${process.env.DB_HOST}"` : '(not set)');
    console.log('  DB_PORT:', process.env.DB_PORT ? `"${process.env.DB_PORT}"` : '(default: 4000)');
    console.log('  DB_USERNAME:', process.env.DB_USERNAME ? `"${process.env.DB_USERNAME}"` : '(not set)');
    console.log('  DB_PASSWORD:', process.env.DB_PASSWORD ? '*** (provided)' : '(not set)');
    console.log('  DB_DATABASE:', process.env.DB_DATABASE ? `"${process.env.DB_DATABASE}"` : '(default: whatsapp_db)');
    console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '*** (provided)' : '(not set)');

    let config = {};
    if (process.env.DB_HOST) {
        config = {
            host: process.env.DB_HOST.replace(/^['"]|['"]$/g, '').trim(),
            port: parseInt(process.env.DB_PORT || '4000', 10),
            user: (process.env.DB_USERNAME || 'root').replace(/^['"]|['"]$/g, '').trim(),
            password: (process.env.DB_PASSWORD || '').replace(/^['"]|['"]$/g, '').trim(),
            database: (process.env.DB_DATABASE || 'whatsapp_db').replace(/^['"]|['"]$/g, '').trim(),
            ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
            connectTimeout: 20000
        };
    } else if (process.env.DATABASE_URL) {
        const parsed = new URL(process.env.DATABASE_URL.replace(/^['"]|['"]$/g, '').trim());
        config = {
            host: parsed.hostname,
            port: parseInt(parsed.port || '4000', 10),
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : 'whatsapp_db',
            ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
            connectTimeout: 20000
        };
    } else {
        console.error('❌ No DB_HOST or DATABASE_URL found in .env!');
        return;
    }

    console.log(`\nAttempting connection to ${config.host}:${config.port}/${config.database} (user: ${config.user})...`);
    const startTime = Date.now();
    try {
        const conn = await mysql.createConnection(config);
        const elapsed = Date.now() - startTime;
        console.log(`✅ Successfully connected in ${elapsed}ms!`);
        const [rows] = await conn.query('SELECT 1 as is_alive, NOW() as server_time');
        console.log('Query result:', rows);
        await conn.end();
        console.log('Diagnostic PASSED! TiDB Cloud is working.');
    } catch (err) {
        const elapsed = Date.now() - startTime;
        console.error(`❌ Connection failed after ${elapsed}ms!`);
        console.error('Error Code:', err.code);
        console.error('Error Message:', err.message);
        console.error('Error Details:', {
            errno: err.errno,
            syscall: err.syscall,
            fatal: err.fatal,
            address: err.address,
            port: err.port
        });
        if (err.code === 'ETIMEDOUT') {
            console.log('\n🔍 Diagnosing ETIMEDOUT:');
            console.log('1. On VPS/Cloud Windows machines, outbound port 4000 is frequently blocked by hosting security groups (e.g. AWS Security Group / Azure NSG / Windows Firewall).');
            console.log('2. Check if outbound traffic on TCP port 4000 is allowed.');
        }
    }
}

testConnection();
