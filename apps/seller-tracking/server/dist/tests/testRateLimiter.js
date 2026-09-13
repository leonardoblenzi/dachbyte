"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rateLimiter_1 = require("../services/rateLimiter");
async function testRateLimiter() {
    console.log('🧪 Testando Rate Limiter...\n');
    // Criar rate limiter de teste (5 req/10s para testar rápido)
    const limiter = new rateLimiter_1.RateLimiter(5, 0.167); // 10 segundos
    console.log('📊 Fazendo 8 requisições (limite: 5)...\n');
    for (let i = 1; i <= 8; i++) {
        await limiter.execute(async () => {
            console.log(`✅ Requisição ${i} executada`);
            const stats = limiter.getStats();
            console.log(`   📊 Restantes: ${stats.remaining}/${stats.maxRequests}`);
            console.log(`   ⏱️  Utilização: ${stats.utilizationPercent}%\n`);
        });
    }
    console.log('🎉 Teste concluído!');
}
testRateLimiter();
