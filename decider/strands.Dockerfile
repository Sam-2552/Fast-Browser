# Self-hosted Strands Decider (no official image exists). CPU-only torch keeps the image small;
# the model (several GB) downloads on first start into the /models volume.
FROM python:3.12-slim

RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir strands-decider

ENV HF_HOME=/models
VOLUME /models
EXPOSE 8000

CMD ["strands-decider", "serve", "StrandsAgents/strands-decider-2B-hobson-v21", \
     "--host", "0.0.0.0", "--port", "8000", "--device", "cpu", "--model-name", "strands-decider"]
