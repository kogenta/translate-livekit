Features Available in the Preview
Unlike older conversational tools that operate turn-by-turn, the 3.5 Live Translate engine uses a continuous audio stream. This allows it to:   
Techsauce

Automatically detect the spoken language without manual toggle configurations.   
Google Blog

Translate speech-to-speech while mimicking the original speaker's emotional tone, pacing, and pitch instead of sounding like a robotic voice synthesis.   
Techsauce

Filter environmental noise, allowing it to parse multi-lingual conversations even in loud surroundings like public transits or restaurants.   
Google Blog

scan codebase and refactor code for real-time translation  Translate both sides of a conversation face to face in real time with low-latency speech recognition, automatic language detection,  Focus Automatically detect the spoken language  ภาษา ENG <-> Thai and Multilingual subtitles.
ใช้สำหรับเป็นล่ามในการพูดคุยในการประชุม คุณสามารถใช้ฟีเจอร์นี้กับการประชุมที่มีการพูดสลับทั้ง 2 ภาษา (อังกฤษ, ไทย) 
ระบบคัดกรองเสียงรบกวน (Filter environmental noise)
และแก้ไขหน้า fontend แสดงผล /watch Split-screen subtitles TH-ENG แยกหน้าจอเป็นฝั่ง ซ้าย-ขวา  แสดงคำที่ถอดเสียง และคำแปล แบบ real time
-ปรับปรุง design style หน้าแสดงผลให้ทันสมัย minimal ลดขนาดส่วนที่ไม่จำเป็น และเกี่ยวข้องลง


Filter environmental noise

คุณสามารถใช้ฟีเจอร์นี้กับการประชุมที่มีการพูดสลับทั้ง 2 ภาษา (อังกฤษ, ไทย) 
ระบบคัดกรองเสียงรบกวน (Filter environmental noise)
และการตรวจจับภาษาอัตโนมัติ (Automatically detect) 

เพื่อให้ทำงานได้ไหลลื่นที่สุดในการประชุมร่วมกัน 3 ภาษานี้ มีเทคนิคการตั้งค่าและข้อจำกัดในคอนเซปต์ของเวอร์ชัน Preview ที่ควรรู้ดังนี้ครับ:

1. วิธีทำงานของการตรวจจับ 2 ภาษาอัตโนมัติ
จับใจความจากบริบท (Contextual Switch): เมื่อคุณพูดไทย อังกฤษ โมเดลจะตรวจจับเสียงและถอดความหมายจาก "บริบทของประโยค" ทันที โดยไม่ต้องกดสลับภาษาไปมา

การแปลข้ามภาษา (Cross-translation): ตัวสตรีมจะแปลงภาษาที่พูด (เช่น ญี่ปุ่น) ให้กลายเป็นภาษาเป้าหมายที่คุณเลือกไว้ปลายทาง (เช่น แปลเป็นไทยทั้งหมด หรือแปลเป็นอังกฤษทั้งหมด) สำหรับผู้ฟังแต่ละคน

2. การทำงานของระบบตัดเสียงรบกวน (Noise Filtering)
เนื่องจากการประชุมมักมีเสียงกระดาษ เสียงพิมพ์คีย์บอร์ด หรือเสียงลมจากเครื่องปรับอากาศ AI จะโฟกัสเฉพาะ Audio Frequency ของเสียงมนุษย์ เพื่อป้องกันไม่ให้เสียงรบกวนรอบข้างหลุดเข้าไปปนในสตรีมที่กำลังแปล ซึ่งช่วยลดโอกาสที่ AI จะ "แปลเพี้ยน" เพราะเสียงรบกวนภายนอกได้มากครับ


Real-time Multi-way interpretation
Translate both sides of a conversation in real time with low-latency speech recognition, automatic language detection, and Multilingual subtitles.

-Real-time speech recognition
-supported languages ENG <-> Thai 
-Automatic language detection
-Split-screen subtitles


 ปรับหน้าจอการแสดงผลหน้า watch 
 - ให้สามารถแสดงต้นฉบับและผลลัพธ์การแปลพร้อมกันขึ้นจอสด ๆได้ 
 โดยอยากให้ทยอยขึ้นระหว่างพูด เพิ่มขนาดตัวอักษร highlight คำและประโยคที่พูดออกมาให้ใหญ่ขึ้น และลดขนาด ประโยคที่ผ่านมาและสามารถปรับขนาดตัวอักษรได้ตามความต้องการของผู้ใช้งาน 
 -เลือก ปิด/ซ่อนฝั่ง sub title ฝั่งใด ฝั่งหนึ่งได้ เมื่อที่จะได้ focus การแปล และดูการแปลย้อยหลัง ง่ายขึ้น
 -นอกจากนี้ยังเพิ่มฟังก์ชันการจบประโยคและส่งผลลัพธ์การแปลทันที เพื่อให้การใช้งานสะดวกและรวดเร็วมากยิ่งขึ้น