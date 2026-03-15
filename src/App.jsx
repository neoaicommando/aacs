import { useState, useRef } from 'react';
import Tesseract from 'tesseract.js';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { Camera, Upload, Trash2, FileText, Download, CheckCircle, Clock, FileSpreadsheet } from 'lucide-react';
import _ from 'lodash';

export default function App() {
  const [receipts, setReceipts] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const fileInputRef = useRef(null);

  // Helper to read file as data url
  const readFileAsDataURL = (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  };

  // Helper to enhance image before OCR (Greyscale + Contrast)
  const enhanceImageForOCR = (dataUrl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        
        // Apply filters to make text sharper for Tesseract
        ctx.filter = 'grayscale(1%) contrast(1.2) brightness(1.1)'; 
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = dataUrl;
    });
  };

  // Helper to extract date and amount from OCR text
  const parseOCRText = (text) => {
    // Improved date matcher (YYYY.MM.DD, YYYY-MM-DD, YY.MM.DD, etc.)
    const dateRegex = /(\d{2,4})[-\./ 년]+(\d{1,2})[-\./ 월]+(\d{1,2})[일]?/;
    const dateMatch = text.match(dateRegex);
    let date = '';
    if (dateMatch) {
      let year = dateMatch[1];
      if (year.length === 2) year = '20' + year;
      date = `${year}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }

    // Improved amount matcher (numbers with commas or dots)
    // Avoid matching dates or small numbers
    const cleanedText = text.replace(dateRegex, ''); // Remove date to avoid confusion
    
    // Match numbers that are likely currency (3+ digits, or with comma/dot)
    // We remove the strict word boundary \b at the end to allow characters like "원"
    const amountRegex = /(\d{1,3}([,.]\d{3})+(?!\d)|(?<!\d)\d{4,})/g;
    const amountMatches = cleanedText.match(amountRegex);
    let maxAmount = 0;
    
    if (amountMatches) {
      amountMatches.forEach(m => {
        // Treat both , and . as separators because OCR often mistakes them
        // Most Korean receipts don't use decimal points for currency
        const val = parseInt(m.replace(/[,.]/g, ''));
        if (val > maxAmount && val < 5000000) { 
          maxAmount = val;
        }
      });
    }

    return {
      date: date,
      amount: maxAmount > 0 ? maxAmount.toString() : '',
    };
  };

  const categories = [
    '유류비',
    '대중교통비',
    '숙박비',
    '식대',
    '해외출장비',
    '회식비',
    '주차비',
    '업무추진비'
  ];

  const processImage = async (file) => {
    const localUrl = URL.createObjectURL(file);
    const dataUrl = await readFileAsDataURL(file);
    
    const newReceipt = {
      id: Math.random().toString(36).substr(2, 9),
      file,
      localUrl,
      dataUrl,
      status: 'processing',
      date: '',
      amount: '',
      category: '식대', // Default category changed to '식대'
    };

    setReceipts(prev => [...prev, newReceipt]);

    // Cleanup reference for timeout
    let ocrTimeout = null;

    try {
      // Step 1: Enhance image for better recognition
      const enhancedDataUrl = await enhanceImageForOCR(dataUrl);
      
      // Step 2: Run OCR with a 15-second watchdog timeout
      const ocrTask = Tesseract.recognize(
        enhancedDataUrl,
        'kor+eng',
        { 
          logger: m => console.log(m),
        }
      );

      const timeoutPromise = new Promise((_, reject) => {
        ocrTimeout = setTimeout(() => reject(new Error('OCR_TIMEOUT')), 15000);
      });

      const result = await Promise.race([ocrTask, timeoutPromise]);
      clearTimeout(ocrTimeout);
      
      const parsed = parseOCRText(result.data.text);
      const fullText = result.data.text.toLowerCase().replace(/\s/g, '');
      
      // Step 3: Robust Smart Category Detection
      if (fullText.includes('주유소') || fullText.includes('주유') || fullText.includes('oil')) {
        parsed.category = '유류비';
      } else if (fullText.includes('주차') || fullText.includes('parking')) {
        parsed.category = '주차비';
      } else if (
        fullText.includes('카카오') || 
        fullText.includes('카카오t') || 
        fullText.includes('택시') || 
        fullText.includes('kakao') || 
        fullText.includes('taxi') || 
        fullText.includes('fifr') || // "카카오" misread pattern common in mobile
        fullText.includes('yuleia')  // "일반택시" misread pattern common in mobile
      ) {
        parsed.category = '대중교통비';
      }
      
      setReceipts(prev => prev.map(r => {
        if (r.id === newReceipt.id) {
          return { ...r, ...parsed, status: 'done', rawText: result.data.text };
        }
        return r;
      }));
    } catch (err) {
      console.error("OCR Error:", err);
      if (ocrTimeout) clearTimeout(ocrTimeout);
      setReceipts(prev => prev.map(r => r.id === newReceipt.id ? { ...r, status: 'error' } : r));
    }
  };

  const handleFileUpload = async (e) => {
    if (!e.target.files?.length) return;
    const files = Array.from(e.target.files);
    
    setIsProcessing(true);
    for (const file of files) {
      await processImage(file);
    }
    setIsProcessing(false);
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateReceipt = (id, field, value) => {
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const removeReceipt = (id) => {
    setReceipts(prev => prev.filter(r => r.id !== id));
  };

  const generatePDF = () => {
    if (receipts.length === 0) return;
    
    const sorted = _.orderBy(receipts, ['date'], ['asc']);
    
    // Change to Landscape (297 x 210 mm) for horizontal layout
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    
    const margin = 10;
    const pageWidth = 297;
    const pageHeight = 210;
    const cols = 3; // 3 columns
    const rows = 2; // 2 rows -> total 6 per page
    const cellWidth = (pageWidth - margin * 2) / cols;
    const cellHeight = (pageHeight - margin * 2) / rows;
    
    let currentItemIdx = 0;
    
    while (currentItemIdx < sorted.length) {
      if (currentItemIdx > 0 && currentItemIdx % (cols * rows) === 0) {
        doc.addPage();
      }
      
      const pageIndex = currentItemIdx % (cols * rows);
      const col = pageIndex % cols;
      const row = Math.floor(pageIndex / cols);
      
      const x = margin + col * cellWidth;
      const y = margin + row * cellHeight;
      const item = sorted[currentItemIdx];
      
      const imgMaxW = cellWidth - 6;
      const imgMaxH = cellHeight - 6; // Increased height since text is gone
      
      if (item.dataUrl) {
        try {
          doc.addImage(item.dataUrl, 'JPEG', x + 3, y + 3, imgMaxW, imgMaxH, undefined, 'FAST');
        } catch(e) {
          console.error("PDF Image Error", e);
        }
      }
      
      doc.setDrawColor(220, 220, 220);
      doc.rect(x, y, cellWidth, cellHeight);
      
      currentItemIdx++;
    }

    
    doc.save('receipts_horizontal.pdf');
  };


  const generateExcel = () => {
    if (receipts.length === 0) return;
    
    // 1. Define the headers as per the screenshot
    const categoriesHeaders = [
      '유류비', '대중교통비', '숙박비', '식대', '해외출장비', '회식비', '주차비', '업무추진비'
    ];
    const headers = ['날짜', ...categoriesHeaders, '합계'];
    
    // 2. Group by date to match the "one row per date" matrix style
    const groupedByDate = _.groupBy(receipts, 'date');
    const sortedDates = _.keys(groupedByDate).sort();
    
    const rows = sortedDates.map(date => {
      const dayReceipts = groupedByDate[date];
      const rowData = new Array(headers.length).fill('');
      rowData[0] = date || '날짜미상';
      
      let dayTotal = 0;
      
      // Sum amounts for each category for this date
      categoriesHeaders.forEach((cat, idx) => {
        const catAmount = dayReceipts
          .filter(r => r.category === cat)
          .reduce((sum, r) => sum + (parseInt(r.amount) || 0), 0);
        
        if (catAmount > 0) {
          rowData[idx + 1] = catAmount; // Put amount in corresponding column
          dayTotal += catAmount;
        }
      });
      
      rowData[headers.length - 1] = dayTotal; // Total column
      return rowData;
    });
    
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '경비정산');
    
    XLSX.writeFile(workbook, 'erp_upload_data.xlsx');
  };

  return (
    <div className="min-h-screen pb-20 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <header className="mb-12 text-center">
        <h1 className="text-4xl font-extrabold text-blue-900 tracking-tight mb-2">AACS</h1>
        <p className="text-gray-600 text-lg font-medium">AUROS Automatic Cost Settlement</p>
      </header>
      
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 md:p-8 mb-8">
        <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-blue-200 rounded-xl bg-blue-50/50 hover:bg-blue-50 transition-colors">
          <input
            type="file"
            accept="image/*"
            multiple
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            id="file-upload"
          />
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileUpload}
            className="hidden"
            id="camera-upload"
          />
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-4 w-full justify-center">
            <label
              htmlFor="file-upload"
              className="cursor-pointer flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-all"
            >
              <Upload className="w-5 h-5 mr-2" />
              사진 업로드 (갤러리)
            </label>
            <label
              htmlFor="camera-upload"
              className="cursor-pointer flex items-center justify-center px-6 py-3 border border-gray-300 text-base font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-all"
            >
              <Camera className="w-5 h-5 mr-2" />
              카메라로 찍기
            </label>
          </div>
          <p className="mt-4 text-sm text-gray-500">스마트폰에서도 이미지 업로드가 가능합니다.</p>
        </div>
      </div>

      {receipts.length > 0 && (
        <div className="mb-8 flex flex-col sm:flex-row justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-gray-200">
          <div className="mb-4 sm:mb-0">
            <span className="text-lg font-semibold text-gray-800">총 {receipts.length}장 업로드 됨</span>
          </div>
          <div className="flex space-x-3 w-full sm:w-auto">
            <button
              onClick={generatePDF}
              className="flex-1 sm:flex-none flex items-center justify-center px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-medium transition-colors shadow-sm"
            >
              <FileText className="w-4 h-4 mr-2" />
              PDF 다운로드
            </button>
            <button
              onClick={generateExcel}
              className="flex-1 sm:flex-none flex items-center justify-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors shadow-sm"
            >
              <Download className="w-4 h-4 mr-2" />
              엑셀 다운로드
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {_.orderBy(receipts, ['date', 'id'], ['asc', 'asc']).map((item, idx) => (
          <div key={item.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
            <div 
              className="relative h-48 bg-gray-100 flex items-center justify-center overflow-hidden cursor-zoom-in group"
              onClick={() => setSelectedImage(item.localUrl)}
            >
              <img src={item.localUrl} alt="Receipt" className="object-contain w-full h-full transition-transform duration-300 group-hover:scale-105" />
              
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 bg-white/90 p-2 rounded-full shadow-lg transition-opacity">
                  <Camera className="w-5 h-5 text-blue-600" />
                </div>
              </div>

              {item.status === 'processing' && (
                <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center text-white backdrop-blur-sm">
                  <Clock className="w-8 h-8 animate-pulse mb-2" />
                  <span className="font-medium">AI 텍스트 추출 중...</span>
                </div>
              )}
              {item.status === 'error' && (
                <div className="absolute inset-0 bg-red-500/80 flex flex-col items-center justify-center text-white backdrop-blur-sm p-4 text-center">
                  <Clock className="w-8 h-8 mb-2 opacity-50" />
                  <span className="font-bold text-sm">인식 실패 (시간 초과)</span>
                  <p className="text-[10px] mt-1">인터넷 연결을 확인하거나<br/>정보를 직접 입력해 주세요.</p>
                </div>
              )}
              {item.status === 'done' && (
                <div className="absolute top-2 right-2 bg-emerald-500 text-white px-2 py-1 rounded text-xs font-bold flex items-center shadow">
                  <CheckCircle className="w-3 h-3 mr-1" /> 완료
                </div>
              )}
              
              <button 
                onClick={(e) => { e.stopPropagation(); removeReceipt(item.id); }}
                className="absolute top-2 left-2 p-1.5 bg-black/50 hover:bg-red-500 text-white rounded-md backdrop-blur-md transition-colors z-10"
                title="삭제"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            
            <div className="p-5 flex flex-col space-y-3 flex-1 bg-gray-50/50">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">결제 날짜</label>
                <div className="relative group/date">
                  <input
                    type="date"
                    value={item.date}
                    onChange={(e) => updateReceipt(item.id, 'date', e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />
                  <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm flex items-center justify-between group-hover/date:border-blue-400 transition-colors">
                    <span className={item.date ? "text-gray-900" : "text-gray-400"}>
                      {item.date || '날짜 선택'}
                    </span>
                    <Clock className="w-4 h-4 text-gray-400" />
                  </div>
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">결제 금액 (원)</label>
                <input
                  type="number"
                  value={item.amount}
                  onChange={(e) => updateReceipt(item.id, 'amount', e.target.value)}
                  placeholder="예: 50000"
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                />
              </div>
              
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">계정과목</label>
                <select
                  value={item.category}
                  onChange={(e) => updateReceipt(item.id, 'category', e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                >
                  {categories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>
      
      {receipts.length === 0 && (
        <div className="text-center py-20 px-4">
          <div className="bg-white mx-auto h-24 w-24 rounded-full flex items-center justify-center shadow-sm border border-gray-100 mb-4">
            <FileSpreadsheet className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-xl font-medium text-gray-900 mb-2">아직 업로드된 영수증이 없습니다</h3>
          <p className="text-gray-500">
            위 버튼을 눌러 영수증 사진을 추가해보세요.<br/>
            사진을 분석해 영수증 정보를 자동으로 입력합니다.
          </p>
        </div>
      )}

      {/* Image Zoom Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4 animate-in fade-in duration-200 cursor-zoom-out"
          onClick={() => setSelectedImage(null)}
        >
          <button className="absolute top-6 right-6 text-white bg-white/10 hover:bg-white/20 p-2 rounded-full transition-colors z-[110]">
             <Trash2 className="w-6 h-6 rotate-45" />
          </button>
          <img 
            src={selectedImage} 
            alt="Zoomed Receipt" 
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
