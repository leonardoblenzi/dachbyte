// Testar se conseguimos carregar os Controllers
console.log('🔍 Iniciando teste dos controllers...\n');

try {
  console.log('🔍 Testando HtmlController...');
  const HtmlController = require('./controllers/HtmlController');
  console.log('✅ HtmlController carregado com sucesso');
  console.log('📋 Métodos disponíveis:', Object.getOwnPropertyNames(HtmlController));
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar HtmlController:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

try {
  console.log('🔍 Testando PromocaoController...');
  const PromocaoController = require('./controllers/PromocaoController');
  console.log('✅ PromocaoController carregado com sucesso');
  console.log('📋 Métodos disponíveis:', Object.getOwnPropertyNames(PromocaoController));
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar PromocaoController:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

try {
  console.log('🔍 Testando TokenController...');
  const TokenController = require('./controllers/TokenController');
  console.log('✅ TokenController carregado com sucesso');
  console.log('📋 Métodos disponíveis:', Object.getOwnPropertyNames(TokenController));
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar TokenController:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

// Testar as rotas
try {
  console.log('🔍 Testando htmlRoutes...');
  const htmlRoutes = require('./routes/htmlRoutes');
  console.log('✅ htmlRoutes carregado com sucesso');
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar htmlRoutes:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

try {
  console.log('🔍 Testando tokenRoutes...');
  const tokenRoutes = require('./routes/tokenRoutes');
  console.log('✅ tokenRoutes carregado com sucesso');
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar tokenRoutes:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

try {
  console.log('🔍 Testando promocaoRoutes...');
  const promocaoRoutes = require('./routes/promocaoRoutes');
  console.log('✅ promocaoRoutes carregado com sucesso');
  console.log('');
} catch (error) {
  console.error('❌ Erro ao carregar promocaoRoutes:', error.message);
  console.error('Stack:', error.stack);
  console.log('');
}

console.log('🎯 Teste concluído!');