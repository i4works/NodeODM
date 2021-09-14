FROM ubuntu:20.04 AS SGDependencyBuilder 

ENV DEBIAN_FRONTEND=noninteractive

run mkdir /Workspace

USER root
RUN apt-get update && apt-get install -y -qq --no-install-recommends curl unzip git cmake gcc g++ make libtbb-dev qtbase5-dev qtchooser qt5-qmake qtbase5-dev-tools libglew-dev libboost-dev libboost-program-options-dev libboost-thread-dev libboost-system-dev libboost-iostreams-dev libboost-filesystem-dev libgeotiff-dev libgdal-dev libproj-dev ca-certificates

WORKDIR "/Workspace"
RUN git clone https://github.com/i4Works/PotreeConverter.git /Workspace/PotreeConverter

WORKDIR "/Workspace/PotreeConverter"
RUN git checkout 2.1.1
RUN mkdir -p build

WORKDIR "/Workspace/PotreeConverter/build"
RUN cmake .. && make

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
RUN make

WORKDIR "/Workspace"
RUN git clone https://github.com/i4works/OpenSfM
WORKDIR "/Workspace/OpenSfM"
RUN git checkout sg-patch

FROM opendronemap/odm:latest
MAINTAINER Piero Toffanin <pt@masseranolabs.com>

EXPOSE 3000

USER root
RUN apt-get update && apt-get install -y curl gpg-agent qtbase5-dev qtchooser qt5-qmake qtbase5-dev-tools
RUN curl --silent --location https://deb.nodesource.com/setup_10.x | bash -


RUN apt-get install -y nodejs npm unzip p7zip-full && npm install -g nodemon && \
    ln -s /code/SuperBuild/install/bin/pdal /usr/bin/pdal && \ 
    ln -s /code/SuperBuild/install/lib/liblaszip.so /usr/lib/liblaszip.so

RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

COPY --from=SGDependencyBuilder /Workspace/PotreeConverter/build/PotreeConverter /usr/bin/PotreeConverter
COPY --from=SGDependencyBuilder /Workspace/nexus/build/src/nxsbuild/nxsbuild /usr/bin/nxsbuild
COPY --from=SGDependencyBuilder /Workspace/nexus/build/src/nxsedit/nxscompress /usr/bin/nxscompress
COPY --from=SGDependencyBuilder /Workspace/IfcConvert /usr/bin/IfcConvert
COPY --from=SGDependencyBuilder /Workspace/LAStools/bin/lasinfo /usr/bin/lasinfo
COPY --from=SGDependencyBuilder /Workspace/OpenSfM/opensfm/report.py /code/SuperBuild/install/bin/opensfm/opensfm/report.py

RUN npm install && mkdir tmp

ENTRYPOINT ["/usr/bin/node", "/var/www/index.js"]
