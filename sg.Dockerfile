ARG FROM_REPO=sg-odm:local

FROM ubuntu:24.04 AS SGDependencyBuilder

ENV DEBIAN_FRONTEND=noninteractive

RUN mkdir /Workspace

USER root
RUN apt-get update && apt-get install -y -qq --no-install-recommends curl unzip git cmake gcc g++ make libtbb-dev qtbase5-dev qtchooser qt5-qmake qtbase5-dev-tools libglew-dev libboost-dev libboost-program-options-dev libboost-thread-dev libboost-system-dev libboost-iostreams-dev libboost-filesystem-dev libgeotiff-dev libgdal-dev libproj-dev ca-certificates libtbbmalloc2

WORKDIR "/Workspace"
RUN git clone https://github.com/cnr-isti-vclab/vcglib.git
RUN git clone https://github.com/cnr-isti-vclab/corto.git
RUN git clone https://github.com/cnr-isti-vclab/nexus.git
RUN git clone https://github.com/LAStools/LAStools.git

WORKDIR "/Workspace/vcglib"
RUN git checkout 2020.09

WORKDIR "/Workspace/corto"
RUN mkdir -p build
RUN cmake -DCMAKE_CXX_FLAGS=-I\ ./include/corto . && make && make install

WORKDIR "/Workspace/nexus"
RUN git checkout 4.3
RUN sed  -i "s/add_subdirectory(src\/nxsview)//" ./CMakeLists.txt
RUN mkdir -p build

WORKDIR "/Workspace/nexus/build"
RUN cmake .. && make

WORKDIR "/Workspace"
RUN curl --silent https://s3.amazonaws.com/ifcopenshell-builds/IfcConvert-v0.6.0-517b819-linux64.zip --output IfcConvert.zip
RUN unzip ./IfcConvert.zip

WORKDIR "/Workspace/LAStools"
RUN cmake -DCMAKE_BUILD_TYPE=Release CMakeLists.txt
RUN cmake --build .

FROM ${FROM_REPO}
MAINTAINER Piero Toffanin <pt@masseranolabs.com>

EXPOSE 3000

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR /usr/local/nvm
ENV NODE_VERSION 14

RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

RUN bash install_deps.sh && \
    ln -s /var/www/node.sh /usr/bin/node && \
    ( [ -f /code/SuperBuild/install/bin/untwine ] && ln -s /code/SuperBuild/install/bin/untwine /usr/bin/untwine || ln -s /code/.pixi/envs/*/bin/untwine /usr/bin/untwine ) && \
    ( [ -f /code/SuperBuild/install/bin/entwine ] && ln -s /code/SuperBuild/install/bin/entwine /usr/bin/entwine || true ) && \
    ( [ -f /code/SuperBuild/install/bin/pdal ] && ln -s /code/SuperBuild/install/bin/pdal /usr/bin/pdal || ln -s /code/.pixi/envs/*/bin/pdal /usr/bin/pdal ) && \
    mkdir -p tmp && node index.js --powercycle

RUN for py in /code/.pixi/envs/*/bin/python; do [ -f "$py" ] && "$py" -m pip install --no-cache-dir rio-cogeo; done && \
    apt-get update && apt-get install -y --no-install-recommends python3-pip && \
    pip3 install --break-system-packages rio-cogeo && \
    rm -rf /var/lib/apt/lists/*

COPY --from=SGDependencyBuilder /Workspace/nexus/build/src/nxsbuild/nxsbuild /usr/bin/nxsbuild
COPY --from=SGDependencyBuilder /Workspace/nexus/build/src/nxsedit/nxscompress /usr/bin/nxscompress
COPY --from=SGDependencyBuilder /Workspace/IfcConvert /usr/bin/IfcConvert
COPY --from=SGDependencyBuilder /Workspace/LAStools/bin64/lasinfo64 /usr/bin/lasinfo
COPY locale/tr.yaml /code/SuperBuild/install/bin/opensfm/opensfm/data/locale/tr.yaml
COPY locale/report_locale.py /code/SuperBuild/install/bin/opensfm/opensfm/report_locale.py
COPY report/sahagozu_logo.png /code/SuperBuild/install/bin/opensfm/doc/images/logo.png
RUN sed -i 's/self.pdf.cell(0, 10, "ODM", align="L")/self.pdf.cell(0, 10, "SahaGözü", align="L")/' /code/SuperBuild/install/bin/opensfm/opensfm/report.py && \
    sed -i 's/5, 203, 99/20, 74, 158/' /code/SuperBuild/install/bin/opensfm/opensfm/report.py
COPY odm-run.sh /code/run.sh
RUN chmod +x /code/run.sh


ENTRYPOINT ["/usr/bin/node", "/var/www/index.js"]
