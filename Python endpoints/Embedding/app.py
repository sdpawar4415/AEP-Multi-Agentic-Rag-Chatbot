from sentence_transformers import SentenceTransformer
from flask import Flask, request, jsonify
 
app = Flask(__name__)
model = SentenceTransformer('all-MiniLM-L6-v2')
 
@app.route('/embed', methods=['POST'])
def embed():
    text = request.json['text']
    embedding = model.encode(text).tolist()
    return jsonify(embedding)
 
app.run(host='0.0.0.0', port=5000)
 