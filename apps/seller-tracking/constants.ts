const normalizedBasePath = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

export const withBasePath = (assetPath: string) => {
  if (!assetPath.startsWith('/')) {
    return assetPath;
  }

  return `${normalizedBasePath}${assetPath}`;
};

// Keep carrier logos separate; this is the customer-facing DACHBYTE Seller mark.
export const LOGO_URL = '/brand/dachbyte/seller/mark-transparent.png';
export const CHATBOT_AVATAR_URL = withBasePath('/muricoca.png');

export const CSV_HEADERS = [
  "Pedido",
  "Data",
  "Nome do Cliente",
  "Razão Social",
  "CPF",
  "CNPJ",
  "Telefone",
  "Celular",
  "Canal de venda",
  "Frete tipo",
  "Frete valor",
  "Envio data",
  "Endereço",
  "Número",
  "Complemento",
  "Bairro",
  "Cidade",
  "Estado",
  "Cep",
  "Total",
  "Destinatário",
  "Prazo máximo de envio",
  "Data estimada de entrega"
];
