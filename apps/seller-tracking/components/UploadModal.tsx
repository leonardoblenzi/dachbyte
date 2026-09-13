
import React, { useState } from 'react';
import { UploadCloud, FileText, AlertCircle, CheckCircle, FileSpreadsheet } from 'lucide-react';
import { Order, OrderStatus } from '../types';
import { clsx } from 'clsx';
import { CSV_HEADERS } from '../constants';
import { read, utils } from 'xlsx';

interface UploadModalProps {
  onUpload: (orders: Order[]) => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({ onUpload }) => {
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Helper: Parse Date DD/MM/YYYY or YYYY-MM-DD
  const parseDate = (dateStr: string | number | Date): Date => {
    try {
      if (!dateStr) return new Date();
      if (dateStr instanceof Date) return dateStr;
      
      const str = String(dateStr).trim();
      
      // Handle DD/MM/YYYY
      if (str.includes('/')) {
        const parts = str.split('/');
        // Assuming DD/MM/YYYY
        return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      }
      return new Date(str);
    } catch {
      return new Date();
    }
  };

  const parseCurrency = (val: string | number): number => {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    // Remove "R$", dots, replace comma with dot
    const clean = String(val).replace(/[^\d,-]/g, '').replace(',', '.');
    return parseFloat(clean) || 0;
  };

  const normalizeFreightType = (rawType: string): string => {
    const type = String(rawType || '').trim().toLowerCase();
    
    // Mercado Livre Logic & Priority
    // "priorit" covers "prioritária", "prioritario", "priority"
    const mlTypes = [
      "encomenda normal",
      "normal ao endereço",
      "retirada normal na agência",
      "retirada prioritaria na agência",
      "retirada prioritária na agência"
    ];

    if (
      mlTypes.some(t => type === t) ||
      type.includes('priorit') ||
      type === 'padrao ao endereco' ||
      type === 'padrão ao endereço'
    ) {
      return "ColetasME2"; 
    }

    // Shopee Logic
    const shopeeTypes = [
      "shopee xpress",
      "retirada pelo comprador"
    ];

    if (shopeeTypes.some(t => type === t)) {
      return "Shopee Xpress";
    }

    if (
      type.includes("correios") ||
      type.includes("sedex") ||
      type === "pac" ||
      type.startsWith("pac ") ||
      type.endsWith(" pac") ||
      type.includes(" pac ") ||
      type.includes("pac tray")
    ) {
      return "Correios";
    }

    // Default return original or placeholder
    return String(rawType || '').trim() || 'Aguardando Sincronização';
  };

  // Helper to detect status from CSV/Excel row
  const parseStatus = (rawStatus: string): OrderStatus => {
      if (!rawStatus) return OrderStatus.PENDING;
      const s = String(rawStatus).toUpperCase().trim();
      
      if (s.includes('ENTREGUE') || s.includes('CONCLUÍDO') || s.includes('DELIVERED') || s.includes('FINALIZADO')) {
          return OrderStatus.DELIVERED;
      }
      if (s.includes('CANCELADO') || s.includes('CANCELED')) {
          return OrderStatus.CANCELED;
      }
      if (s.includes('DEVOLVIDO') || s.includes('RETURNED')) {
          return OrderStatus.RETURNED;
      }
      if (s.includes('FALHA') || s.includes('ROUBO') || s.includes('EXTRAVIO')) {
          return OrderStatus.FAILURE;
      }
      if (s.includes('TRANSITO') || s.includes('ENVIADO')) {
          return OrderStatus.SHIPPED;
      }
      
      return OrderStatus.PENDING;
  };

  const createOrderFromData = (getValue: (key: string) => any): Order | null => {
      const statusVal = getValue('Status') || getValue('Situação') || getValue('Estado') || '';
      const initialStatus = parseStatus(statusVal);

      // 🛑 EXCLUDE CANCELED ORDERS IMMEDIATELY
      if (initialStatus === OrderStatus.CANCELED) {
          return null;
      }

      const rawFreight = getValue('Frete tipo');
      const normalizedFreight = normalizeFreightType(rawFreight);

      // 🛑 EXCLUDE CHANNEL LOGISTICS ORDERS IMMEDIATELY
      const estimatedDate = parseDate(getValue('Data estimada de entrega'));
      const maxDeadline = parseDate(getValue('Prazo máximo de envio'));
      const now = new Date();

      // Platform forecast only; transportadora delay is calculated later from tracking
      const isPlatformDelayed =
        (now > estimatedDate) ||
        (now > maxDeadline);
      
      // Removed duplicate declarations
      // const rawFreight = getValue('Frete tipo');
      // const normalizedFreight = normalizeFreightType(rawFreight);

      const orderNumber = getValue('Pedido');
      if (!orderNumber) return null;

      return {
        id: orderNumber || `GEN-${Math.random().toString(36).substr(2, 9)}`,
        orderNumber: String(orderNumber),
        trackingCode: getValue('Código de rastreio') || '',
        customerName: getValue('Nome do Cliente') || 'Desconhecido',
        corporateName: getValue('Razão Social'),
        cpf: getValue('CPF'),
        cnpj: getValue('CNPJ'),
        phone: getValue('Telefone'),
        mobile: getValue('Celular'),
        salesChannel: getValue('Canal de venda') || 'Não identificado',
        freightType: normalizedFreight,
        freightValue: parseCurrency(getValue('Frete valor')),
        shippingDate: parseDate(getValue('Envio data')),
        address: getValue('Endereço') || '',
        number: getValue('Número') || '',
        complement: getValue('Complemento'),
        neighborhood: getValue('Bairro') || '',
        city: getValue('Cidade') || '',
        state: getValue('Estado') || '',
        zipCode: getValue('Cep') || '',
        totalValue: parseCurrency(getValue('Total')),
        recipient: getValue('Destinatário'),
        maxShippingDeadline: maxDeadline,
        estimatedDeliveryDate: estimatedDate,
        carrierEstimatedDeliveryDate: null,
        status: initialStatus,
        isDelayed: false,
        isPlatformDelayed,
        trackingHistory: [],
        lastApiSync: null,
        lastUpdate: new Date()
      };
  };

  const processFile = async (file: File) => {
    setIsProcessing(true);
    setError(null);
    setFileName(file.name);

    const isCsv = file.type === 'text/csv' || file.name.endsWith('.csv');
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    if (!isCsv && !isExcel) {
      setError('Formato inválido. Por favor envie um arquivo CSV, XLS ou XLSX.');
      setIsProcessing(false);
      return;
    }

    try {
        const newOrders: Order[] = [];

        if (isCsv) {
            const text = await file.text(); // Modern browser API
            // Use ISO-8859-1 check might be needed if standard text() fails encoding, 
            // but standard text() is usually UTF-8. For legacy CSVs, FileReader with specific encoding is safer.
            
            // Revert to FileReader for encoding control if needed, but let's try manual read first
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const content = e.target?.result as string;
                const lines = content.split('\n');
                
                if (lines.length < 2) throw new Error("Arquivo vazio ou sem cabeçalho.");

                // Detect separator
                let separator = ';';
                let headers = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
                if (headers.length < 2) {
                    separator = ',';
                    headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
                }

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    
                    const cols = line.split(separator).map(c => c.trim().replace(/"/g, ''));
                    const getValue = (headerName: string) => {
                        const index = headers.indexOf(headerName);
                        return (index > -1 && cols[index] !== undefined) ? cols[index] : '';
                    };

                    const order = createOrderFromData(getValue);
                    if (order) newOrders.push(order);
                }
                finalize(newOrders);
            };
            reader.readAsText(file, 'ISO-8859-1');

        } else if (isExcel) {
            const buffer = await file.arrayBuffer();
            const workbook = read(buffer);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            
            // Convert to JSON, formatted as strings (raw: false) to match CSV parsing logic
            const jsonData = utils.sheet_to_json<any>(worksheet, { defval: "" });

            for (const row of jsonData) {
                const getValue = (headerName: string) => row[headerName];
                const order = createOrderFromData(getValue);
                if (order) newOrders.push(order);
            }
            finalize(newOrders);
        }

    } catch (err) {
        setError("Erro ao processar arquivo. Verifique o layout.");
        console.error(err);
        setIsProcessing(false);
    }
  };

  const finalize = (orders: Order[]) => {
      setIsProcessing(false);
      if (orders.length === 0) {
          setError("Nenhum pedido válido encontrado (Verifique se não eram todos cancelados).");
      } else {
          onUpload(orders);
      }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 animate-in zoom-in duration-300">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-slate-800 dark:text-white">Importação de Dados</h2>
            <p className="text-slate-500 dark:text-slate-400 mt-2">Faça o upload da sua planilha CSV ou Excel para gerar o dashboard.</p>
        </div>

        <div 
          className={clsx(
            "relative border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-200",
            dragActive 
                ? "border-accent bg-accent/5 dark:bg-accent/10 scale-102" 
                : "border-slate-300 dark:border-white/10 bg-white dark:bg-dark-card hover:border-accent/50",
            error ? "border-red-300 bg-red-50 dark:bg-red-900/10" : ""
          )}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input 
            type="file" 
            id="file-upload" 
            className="hidden" 
            accept=".csv, .xls, .xlsx"
            onChange={handleChange}
          />
          
          <div className="flex flex-col items-center gap-4">
            <div className={clsx("p-4 rounded-full", error ? "bg-red-100 dark:bg-red-900/20 text-red-500" : "bg-blue-50 dark:bg-blue-900/20 text-accent")}>
               {error ? <AlertCircle className="w-8 h-8"/> : <FileSpreadsheet className="w-8 h-8" />}
            </div>
            
            <div>
                {fileName ? (
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400 font-medium justify-center">
                        <CheckCircle className="w-5 h-5"/>
                        {fileName}
                    </div>
                ) : (
                    <>
                        <p className="text-lg font-medium text-slate-700 dark:text-white">Arraste e solte seu arquivo aqui</p>
                        <p className="text-sm text-slate-400 mt-1">Suporta CSV, XLS e XLSX</p>
                    </>
                )}
            </div>

            {!fileName && (
                <label 
                htmlFor="file-upload" 
                className="cursor-pointer px-6 py-2 bg-slate-900 dark:bg-white text-white dark:text-black rounded-lg hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors font-medium shadow-lg shadow-slate-900/20"
                >
                Selecionar Arquivo
                </label>
            )}

            {isProcessing && (
                <p className="text-accent animate-pulse font-medium">Processando dados...</p>
            )}

            {error && (
                <p className="text-red-500 text-sm mt-2">{error}</p>
            )}
          </div>
        </div>

        <div className="mt-8 bg-white dark:bg-dark-card p-6 rounded-xl border border-slate-200 dark:border-white/10 shadow-sm">
            <div className="flex items-center gap-2 mb-4 text-slate-800 dark:text-white font-semibold">
                <FileText className="w-5 h-5"/>
                <h3>Layout Esperado</h3>
            </div>
            <div className="flex flex-wrap gap-2">
                {CSV_HEADERS.slice(0, 8).map(h => (
                    <span key={h} className="text-xs bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 px-2 py-1 rounded border border-slate-200 dark:border-white/5">{h}</span>
                ))}
                <span className="text-xs text-slate-400 pt-1">... + Status (Opcional)</span>
            </div>
        </div>
      </div>
    </div>
  );
};
